//! Prints a letter's sheet into a PDF file through the code the app prints with (#70), on macOS,
//! without the print panel, and looks for the header's text in the file. Run by the macOS job of
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
    use std::time::{Duration, Instant};

    // A print that hangs would hold the job for hours: say where it stands and stop after two minutes.
    static STAGE: std::sync::Mutex<&str> = std::sync::Mutex::new("start");
    let stage = |name: &'static str| {
        eprintln!("mac_print: {name}");
        *STAGE.lock().unwrap() = name;
    };
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(120));
        eprintln!("mac_print: stuck at «{}» for two minutes", STAGE.lock().unwrap());
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
    stage("loading the sheet");

    let sheet = Sheet::load(mtm, &window, include_str!("fixtures/sheet.html")).expect("the window has a content view");
    let run_loop = NSRunLoop::currentRunLoop();
    let started = Instant::now();
    let mut quiet = 0;
    while quiet < 2 {
        assert!(started.elapsed() < Duration::from_secs(30), "the sheet did not load");
        run_loop.runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.1));
        quiet = if sheet.loading() { 0 } else { quiet + 1 };
    }

    stage("printing into a PDF");
    let pdf = std::env::temp_dir().join(format!("depesha-sheet-{}.pdf", std::process::id()));
    let _ = std::fs::remove_file(&pdf);
    sheet.print(&window, &Output::Pdf(pdf.clone()));
    // The print runs on a thread of its own: spin the loop until the file is there and stops growing.
    let started = Instant::now();
    let mut last = 0;
    let mut steady = 0;
    while steady < 3 {
        assert!(started.elapsed() < Duration::from_secs(60), "no PDF was written");
        run_loop.runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.3));
        let size = std::fs::metadata(&pdf).map_or(0, |m| m.len());
        steady = if size > 0 && size == last { steady + 1 } else { 0 };
        last = size;
    }
    stage("reading the PDF");
    let bytes = std::fs::read(&pdf).expect("no PDF was written");
    assert!(
        bytes.starts_with(b"%PDF"),
        "not a PDF: {:?}",
        &bytes[..bytes.len().min(16)]
    );
    assert!(bytes.len() > 2000, "the PDF is empty: {} bytes", bytes.len());

    let text = std::process::Command::new("pdftotext")
        .arg("-layout")
        .arg(&pdf)
        .arg("-")
        .output()
        .expect("pdftotext (brew install poppler)");
    let text = String::from_utf8_lossy(&text.stdout).into_owned();
    println!("{text}");
    for part in [
        "Invoice 42",
        "Anna Petrova",
        "anna@example.com",
        "invoice-42.pdf",
        "Payment due",
    ] {
        assert!(text.contains(part), "the PDF has no «{part}»");
    }
    for part in ["Кому", "Вложения"] {
        assert!(
            text.contains(part),
            "the PDF has no «{part}»: the Cyrillic of the header is lost"
        );
    }
    let _ = std::fs::remove_file(&pdf);
    println!("the sheet printed: {} bytes of PDF", bytes.len());
}
