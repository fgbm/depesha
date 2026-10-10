//! `cargo run -p depesha-core --example detect -- user@example.org`
//! Prints the detected server settings; does not log in.

#[tokio::main]
async fn main() {
    for email in std::env::args().skip(1) {
        let started = std::time::Instant::now();
        let d = depesha_core::autodetect::detect(&email).await;
        println!(
            "{email} ({:.1} с): {}",
            started.elapsed().as_secs_f32(),
            serde_json::to_string_pretty(&d).unwrap_or_else(|e| e.to_string())
        );
    }
}
