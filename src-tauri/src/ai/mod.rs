pub mod batching;
pub mod branch_name;
pub mod client;
pub mod commands;
pub mod commit_message;
pub mod errors;
pub mod limits;
pub mod prompts;
pub mod provider;
pub mod review;
pub mod review_cache;
pub mod review_commands;
pub mod review_pipeline;
pub mod review_status;
pub mod sanitize;
pub mod schema;
pub mod secrets;
pub mod snapshot;

#[cfg(test)]
mod provider_fixtures;

pub const AI_PROGRESS_EVENT: &str = "ai://request-progress";
