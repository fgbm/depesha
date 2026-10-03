//! Passwords in the OS keyring: Secret Service on Linux, Keychain, Credential Manager.

use crate::error::{CmdError, CmdResult};

const SERVICE: &str = "ru.depesha.mail";

fn entry(account_id: &str) -> CmdResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, account_id).map_err(|e| CmdError::new("keyring", format!("связка ключей: {e}")))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::new("keyring", e.to_string()))?
}

pub async fn get(account_id: &str) -> CmdResult<Option<String>> {
    let id = account_id.to_owned();
    blocking(move || match entry(&id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CmdError::new("keyring", format!("связка ключей недоступна: {e}"))),
    })
    .await
}

pub async fn set(account_id: &str, password: String) -> CmdResult<()> {
    let id = account_id.to_owned();
    blocking(move || {
        entry(&id)?
            .set_password(&password)
            .map_err(|e| CmdError::new("keyring", format!("не удалось сохранить пароль в связку ключей: {e}")))
    })
    .await
}

pub async fn delete(account_id: &str) -> CmdResult<()> {
    let id = account_id.to_owned();
    blocking(move || match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CmdError::new("keyring", e.to_string())),
    })
    .await
}
