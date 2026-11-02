use proof_core::{Error, Proof, ReadCancellation};
use proof_swift_bridge::{dispatch, Request, Response, MAX_REQUEST_BYTES};
use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
    sync::{mpsc, Arc, Mutex},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("proof-swift-bridge: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let data_dir = args
        .next()
        .ok_or("Usage: proof-swift-bridge <native-data-directory>")?;
    if args.next().is_some() {
        return Err("Expected exactly one data-directory argument".into());
    }
    let mut core = Proof::open(data_dir)?;
    let cancellations = Arc::new(Mutex::new(HashMap::<u64, ReadCancellation>::new()));
    let reader_cancellations = cancellations.clone();
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            // Bound allocation, including malformed frames without a newline.
            let mut bytes = Vec::new();
            let read = input
                .by_ref()
                .take((MAX_REQUEST_BYTES + 1) as u64)
                .read_until(b'\n', &mut bytes);
            match read {
                Ok(0) | Err(_) => break,
                _ => {}
            }
            if bytes.len() > MAX_REQUEST_BYTES {
                break;
            }
            let raw: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(raw) => raw,
                Err(error) => {
                    if tx
                        .send(Err(Response::new(
                            0,
                            Err(Error::new("INVALID_REQUEST", "Invalid JSON request", error)),
                        )))
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
            };
            if let Some(id) = raw.get("cancel").and_then(|v| v.as_u64()) {
                if raw.as_object().is_some_and(|o| o.len() == 1) {
                    if let Some(cancel) = reader_cancellations.lock().unwrap().get(&id) {
                        cancel.cancel();
                    }
                    continue;
                }
            }
            let id = raw.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            let request: Request = match serde_json::from_value(raw) {
                Ok(request) => request,
                Err(error) => {
                    if tx
                        .send(Err(Response::new(
                            id,
                            Err(Error::new(
                                "INVALID_REQUEST",
                                "Unsupported or malformed request",
                                error,
                            )),
                        )))
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
            };
            let cancellation = ReadCancellation::default();
            if request.command.cancellable() {
                reader_cancellations
                    .lock()
                    .unwrap()
                    .insert(id, cancellation.clone());
            }
            if tx.send(Ok((request, cancellation))).is_err() {
                break;
            }
        }
        for cancel in reader_cancellations.lock().unwrap().values() {
            cancel.cancel();
        }
    });
    let mut output = io::stdout().lock();
    for item in rx {
        let response = match item {
            Err(response) => response,
            Ok((request, cancellation)) => {
                let id = request.id;
                let result = if request.command.cancellable() {
                    cancellation.run(|| dispatch(&mut core, request.command))
                } else {
                    dispatch(&mut core, request.command)
                };
                cancellations.lock().unwrap().remove(&id);
                Response::new(id, result)
            }
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
