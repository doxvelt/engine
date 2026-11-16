use crate::{Bridge, Reply};
use doxvelt_engine::{
    cli::{self, ModelClient},
    error::{EngineError, ErrorCode, Result},
};
use serde_json::Value;
use tokio::{runtime::Handle, sync::watch};
struct Models {
    bridge: Bridge,
    runtime: Handle,
    abort: watch::Receiver<u64>,
}
impl ModelClient for Models {
    fn generate(&mut self, request: Value) -> Result<String> {
        self.runtime.block_on(async {
            let value=tokio::select! {result=self.bridge.call("cli.generate",request)=>result.map_err(|_|EngineError {code:ErrorCode::Internal,message:"CLI model service failed.".into()})?,_=self.abort.changed()=>return Err(EngineError::invalid("CLI model operation was cancelled."))};
            value["text"].as_str().map(str::to_owned).ok_or_else(||EngineError::invalid("CLI model service returned invalid text."))
        })
    }
}
pub async fn execute(bridge: &Bridge, params: Value, mut abort: watch::Receiver<u64>) -> Reply {
    let Ok(arguments) = serde_json::from_value::<Vec<String>>(params["arguments"].clone()) else {
        return Reply::error(400, "CLI arguments must be strings.");
    };
    let mut models = Models {
        bridge: bridge.clone(),
        runtime: Handle::current(),
        abort: abort.clone(),
    };
    let work = tokio::task::spawn_blocking(move || cli::execute(&arguments, &mut models));
    tokio::select! {
        result=work=>match result {Ok(Ok(result))=>Reply::ok(result),Ok(Err(error))=>{let error:crate::HostError=error.into();Reply::error(error.status,&error.message)},Err(_)=>Reply::error(500,"Native CLI operation failed.")},
        _=abort.changed()=>Reply::error(503,"CLI operation was cancelled."),
    }
}
