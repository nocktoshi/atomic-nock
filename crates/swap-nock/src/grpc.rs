//! Nockchain gRPC-Web client. Port of iris-wasm's `GrpcClient`, returning native
//! `Result`s instead of `JsValue`. Uses the iris-rs proto-generated client over
//! `tonic-web-wasm-client` (the in-tree solution to browser gRPC — no HTTP/2).
//!
//! wasm-only: `tonic-web-wasm-client` targets the browser fetch API.

use iris_grpc_proto::pb::common::v1::{Base58Hash, PageRequest};
use iris_grpc_proto::pb::common::v2 as pb;
use iris_grpc_proto::pb::public::v2::{
    nockchain_service_client::NockchainServiceClient, transaction_accepted_response,
    wallet_get_balance_request, wallet_get_balance_response, wallet_send_transaction_response,
    TransactionAcceptedRequest, WalletGetBalanceRequest, WalletSendTransactionRequest,
};
use tonic_web_wasm_client::Client;

#[derive(Debug, Clone)]
pub struct NockError(pub String);

impl core::fmt::Display for NockError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

type Result<T> = core::result::Result<T, NockError>;

/// A gRPC-Web client bound to a Nockchain RPC endpoint (the dev proxy origin, or
/// the configured upstream/Envoy gateway).
pub struct NockGrpc {
    endpoint: String,
}

impl NockGrpc {
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
        }
    }

    fn client(&self) -> NockchainServiceClient<Client> {
        NockchainServiceClient::new(Client::new(self.endpoint.clone()))
    }

    fn page() -> PageRequest {
        PageRequest {
            client_page_items_limit: 0,
            page_token: String::new(),
            max_bytes: 0,
        }
    }

    /// Fetch a wallet's notes/balance by its first-name (pkh hash). Port of
    /// `getBalanceByFirstName`.
    pub async fn get_balance_by_first_name(&self, first_name: String) -> Result<pb::Balance> {
        let mut client = self.client();
        let request = WalletGetBalanceRequest {
            selector: Some(wallet_get_balance_request::Selector::FirstName(Base58Hash {
                hash: first_name,
            })),
            page: Some(Self::page()),
        };
        let response = client
            .wallet_get_balance(request)
            .await
            .map_err(|e| NockError(format!("gRPC error: {e}")))?
            .into_inner();
        match response.result {
            Some(wallet_get_balance_response::Result::Balance(b)) => Ok(b),
            Some(wallet_get_balance_response::Result::Error(e)) => {
                Err(NockError(format!("Server error: {}", e.message)))
            }
            None => Err(NockError("Empty response from server".into())),
        }
    }

    /// Broadcast a signed raw transaction. Port of `sendTransaction`.
    pub async fn send_transaction(&self, raw_tx: pb::RawTransaction) -> Result<()> {
        let mut client = self.client();
        let tx_id = raw_tx.id;
        let request = WalletSendTransactionRequest {
            tx_id,
            raw_tx: Some(raw_tx),
        };
        let response = client
            .wallet_send_transaction(request)
            .await
            .map_err(|e| NockError(format!("gRPC error: {e}")))?
            .into_inner();
        match response.result {
            Some(wallet_send_transaction_response::Result::Ack(_)) => Ok(()),
            Some(wallet_send_transaction_response::Result::Error(e)) => {
                Err(NockError(format!("Server error: {}", e.message)))
            }
            None => Err(NockError("Empty response from server".into())),
        }
    }

    /// Poll whether a tx id has been accepted into the chain. Port of
    /// `transactionAccepted`.
    pub async fn transaction_accepted(&self, tx_id: String) -> Result<bool> {
        let mut client = self.client();
        let request = TransactionAcceptedRequest {
            tx_id: Some(Base58Hash { hash: tx_id }),
        };
        let response = client
            .transaction_accepted(request)
            .await
            .map_err(|e| NockError(format!("gRPC error: {e}")))?
            .into_inner();
        match response.result {
            Some(transaction_accepted_response::Result::Accepted(a)) => Ok(a),
            Some(transaction_accepted_response::Result::Error(e)) => {
                Err(NockError(format!("Server error: {}", e.message)))
            }
            None => Err(NockError("Empty response from server".into())),
        }
    }
}
