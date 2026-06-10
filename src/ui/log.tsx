/** Message-box logging — React port of the old log()/logErr() helpers. */
import { useCallback, useState } from "react";
import { formatGrpcError } from "../grpc.js";

export interface LogState {
  msg: string;
  cls: "" | "ok" | "error";
}

export interface LogApi {
  state: LogState;
  /** Set the message. `ok` styles it green; messages starting with "Error" style red. */
  log(msg: string, ok?: boolean): void;
  /** Format and show an error (with cause), matching the old logErr behavior. */
  logErr(err: unknown): void;
}

export function useLog(initial = ""): LogApi {
  const [state, setState] = useState<LogState>({ msg: initial, cls: "" });

  const log = useCallback((msg: string, ok = false) => {
    setState({ msg, cls: ok ? "ok" : msg.startsWith("Error") ? "error" : "" });
  }, []);

  const logErr = useCallback((err: unknown) => {
    console.error("atomic-nock error:", err);
    const msg = formatGrpcError(err);
    const cause =
      err instanceof Error && err.cause != null ? formatGrpcError(err.cause) : null;
    const text = cause && cause !== msg ? `Error: ${msg}\n${cause}` : `Error: ${msg}`;
    setState({ msg: text, cls: "error" });
  }, []);

  return { state, log, logErr };
}

/** The `.log` message box. */
export function LogBox({ state }: { state: LogState }) {
  return <div className={"log" + (state.cls ? ` ${state.cls}` : "")}>{state.msg}</div>;
}
