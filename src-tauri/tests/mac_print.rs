//! Prints a letter's sheet into a PDF file through the code the app prints with (#70), on macOS,
//! without the print panel, and looks for the header's text in the file. Two prints in a row: the
//! second sheet loads while the first is still being printed, and neither is cut short. Run by the macOS job of
//! CI (`brew install poppler` for `pdftotext`). It has its own `main`: AppKit and WebKit want the
//! main thread, which the test harness does not give to a test.

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    use depesha_lib::print_mac::{Output, Sheet};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize};
    use std::cell::Cell;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    const SHEET: &str = include_str!("fixtures/sheet.html");

    // A print that hangs would hold the job for hours: say where it stands and stop after three minutes.
    static STAGE: std::sync::Mutex<&str> = std::sync::Mutex::new("start");
    let stage = |name: &'static str| {
        eprintln!("mac_print: {name}");
        *STAGE.lock().unwrap() = name;
    };
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(180));
        eprintln!("mac_print: stuck at «{}» for three minutes", STAGE.lock().unwrap());
        std::process::exit(2);
    });

    let mtm = MainThreadMarker::new().expect("the test runs on the main thread");
    stage("application");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    // SAFETY: a plain borderless window on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(800.0, 600.0)),
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    window.orderBack(None);
    let run_loop = NSRunLoop::currentRunLoop();
    let spin = |secs: f64| run_loop.runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(secs));

    let loaded = |name: &str| {
        let sheet = Sheet::load(mtm, &window, SHEET).expect("the window has a content view");
        let started = Instant::now();
        let mut quiet = 0;
        while quiet < 2 {
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "the sheet {name} did not load"
            );
            spin(0.1);
            quiet = if sheet.loading() { 0 } else { quiet + 1 };
        }
        sheet
    };
    let pdf_in = |name: &str| -> PathBuf {
        let pdf = std::env::temp_dir().join(format!("depesha-sheet-{}-{name}.pdf", std::process::id()));
        depesha_core::best_effort("remove the pdf", std::fs::remove_file(&pdf));
        pdf
    };
    // The print runs on a thread of its own: spin the loop until the file is there and stops growing.
    let written = |pdf: &Path| {
        let started = Instant::now();
        let mut last = 0;
        let mut steady = 0;
        while steady < 3 {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "no PDF was written: {}",
                pdf.display()
            );
            spin(0.3);
            let size = std::fs::metadata(pdf).map_or(0, |m| m.len());
            steady = if size > 0 && size == last { steady + 1 } else { 0 };
            last = size;
        }
    };
    let text_of = |pdf: &Path| {
        let bytes = std::fs::read(pdf).expect("no PDF was written");
        assert!(
            bytes.starts_with(b"%PDF"),
            "not a PDF: {:?}",
            &bytes[..bytes.len().min(16)]
        );
        assert!(bytes.len() > 2000, "the PDF is empty: {} bytes", bytes.len());
        let out = std::process::Command::new("pdftotext")
            .arg("-layout")
            .arg(pdf)
            .arg("-")
            .output()
            .expect("pdftotext (brew install poppler)");
        (bytes.len(), String::from_utf8_lossy(&out.stdout).into_owned())
    };

    // The first print starts; the second sheet loads while it goes on, and is printed in its turn.
    stage("the first sheet");
    let first = loaded("one");
    let (pdf1, pdf2) = (pdf_in("one"), pdf_in("two"));
    let done1 = Rc::new(Cell::new(None));
    let seen = done1.clone();
    first.print(mtm, &window, &Output::Pdf(pdf1.clone()), move |ok| seen.set(Some(ok)));
    stage("the second sheet loads during the first print");
    let second = loaded("two");
    // A sheet that is never printed leaves the window with its handle.
    drop(loaded("three, to be dropped"));
    stage("the second print");
    let done2 = Rc::new(Cell::new(None));
    let seen = done2.clone();
    second.print(mtm, &window, &Output::Pdf(pdf2.clone()), move |ok| seen.set(Some(ok)));
    written(&pdf1);
    written(&pdf2);
    let started = Instant::now();
    while done1.get().is_none() || done2.get().is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "AppKit did not report the prints over"
        );
        spin(0.1);
    }
    assert_eq!((done1.get(), done2.get()), (Some(true), Some(true)), "a print failed");

    stage("reading the PDFs");
    for (name, pdf) in [("one", &pdf1), ("two", &pdf2)] {
        let (size, text) = text_of(pdf);
        println!("{text}");
        for part in [
            "Invoice 42",
            "Anna Petrova",
            "anna@example.com",
            "invoice-42.pdf",
            "Payment due",
        ] {
            assert!(text.contains(part), "the PDF {name} has no «{part}»");
        }
        for part in ["Кому", "Вложения"] {
            assert!(
                text.contains(part),
                "the PDF {name} has no «{part}»: the Cyrillic of the header is lost"
            );
        }
        println!("the sheet {name} printed: {size} bytes of PDF");
        depesha_core::best_effort("remove the pdf", std::fs::remove_file(pdf));
    }
}
