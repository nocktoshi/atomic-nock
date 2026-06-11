//! Dev helper: mint a session token for a pkh, so the worker's authed endpoints
//! can be smoke-tested under `wrangler dev` without a live Iris signature.
//!
//!   cargo run -q --example mint_token -- <pkh> <secret> <exp_ms>

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pkh = args.get(1).expect("usage: mint_token <pkh> <secret> <exp_ms>");
    let secret = args.get(2).expect("missing secret");
    let exp_ms: u64 = args.get(3).expect("missing exp_ms").parse().expect("exp_ms");
    println!("{}", swap_core::session::issue_token(pkh, secret, exp_ms));
}
