use proof_observer::{bridge, protocol::BRIDGE_DEADLINE_MS};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn main() {
    let started = Instant::now();
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "bridge") {
        bridge::silence_output();
        std::panic::set_hook(Box::new(|_| {}));
        // The watchdog bounds even a blocked local credential read. No child
        // process, Git, database, model, or GUI is involved in the bridge.
        let deadline = started + Duration::from_millis(BRIDGE_DEADLINE_MS);
        let watchdog = std::thread::Builder::new().spawn(move || {
            std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
            #[cfg(unix)]
            unsafe {
                libc::_exit(0);
            }
            #[cfg(not(unix))]
            std::process::exit(0);
        });
        if watchdog.is_err() {
            return;
        }
        let _ = std::panic::catch_unwind(|| {
            if args.len() == 4 && args[2] == "--registration" {
                let _ = bridge::forward(Path::new(&args[3]), 0, deadline);
            }
        });
        return;
    }
    if args.get(1).is_some_and(|a| a == "--version") {
        println!("proof-observer {}", env!("CARGO_PKG_VERSION"));
    }
    #[cfg(unix)]
    if args.len() == 4
        && args[1] == "serve"
        && args[2] == "--data-dir"
        && proof_observer::runtime::serve(Path::new(&args[3])).is_err()
    {
        eprintln!("PROOF_OBSERVER_START_OR_RUNTIME_ERROR");
        std::process::exit(1);
    }
}
