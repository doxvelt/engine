use crate::Reply;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::watch;
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
pub async fn execute(params: Value, mut abort: watch::Receiver<u64>) -> Reply {
    let Some(directory) = params["directory"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
    else {
        return Reply::error(400, "A registered workspace directory is required.");
    };
    let Some(action) = params["action"].as_str().map(str::to_owned) else {
        return Reply::error(400, "A workspace operation is required.");
    };
    let cancellation = CancelOnDrop(Arc::new(AtomicBool::new(false)));
    let cancelled = cancellation.0.clone();
    let worker = tokio::task::spawn_blocking(move || {
        doxvelt_engine::collection::execute(&directory, &action, &params["body"], &|| {
            cancelled.load(Ordering::SeqCst)
        })
    });
    tokio::select! {
        result=worker=>match result {
            Ok(Ok(value))=>Reply::ok(value),
            Ok(Err(error))=>Reply {status:error.status,body:json!({"error":error.message,"code":error.code}),headers:Default::default()},
            Err(_)=>Reply::error(500,"Native workspace operation failed."),
        },
        _=abort.changed()=>Reply::error(503,"Workspace operation was cancelled."),
    }
}
