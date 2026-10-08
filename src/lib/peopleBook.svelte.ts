// The book of people as the rest of the app reads it (#66, #44): one cache of the address
// book, read once and kept, so a card in a letter, the compose window and the settings page
// all see the same records. Saving writes the record and updates the cache, so a rule set
// in one place is in force in the others at once.
import { emit } from "@tauri-apps/api/event";
import { api } from "./api";
import { findPerson, type Person } from "./people";

export class PeopleBook {
  list = $state<Person[]>([]);
  /** The read in flight: several callers waiting for the first one share it. */
  private reading: Promise<void> | null = null;
  /** The book was read: it stays until something changes it. */
  private loaded = false;
  /** Own changes already applied to the cache: their broadcast needs no re-read. */
  private ownChanges = 0;

  /** Reads the book once; later callers get the cache. A failure leaves the previous list. */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = api
      .people("")
      .then((list) => {
        this.list = list;
        this.loaded = true;
      })
      .catch(() => {})
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  /** The book changed in another window: read it again. Own changes are already in the cache. */
  changed() {
    if (this.ownChanges > 0) {
      this.ownChanges--;
      return;
    }
    void this.refresh();
  }

  /** Tells the other windows the book changed; the local cache is already up to date. */
  private announce() {
    this.ownChanges++;
    emit("people-changed", {}).catch(() => {
      this.ownChanges--;
    });
  }

  /** The record of an address, or none: an address without a rule is not a record. */
  find(email: string): Person | undefined {
    return findPerson(this.list, email);
  }

  /** Saves a record and keeps the cache in step with it. */
  async save(person: Person) {
    this.list = this.list.map((p) => (p.email === person.email ? person : p));
    await api.personSave(person);
    this.loaded = true;
    this.announce();
  }

  /** Forgets a person added by hand. */
  async forget(email: string) {
    if (!(await api.personForget(email))) return;
    this.list = this.list.filter((p) => p.email.toLowerCase() !== email.toLowerCase());
    this.announce();
  }

  /** Reads the book again, after the settings page changed it elsewhere. */
  async refresh() {
    this.list = await api.people("");
    this.loaded = true;
  }
}

export const peopleBook = new PeopleBook();
