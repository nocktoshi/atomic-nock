/** Settings — notification channels (profile, synced) + Nockchain RPC override
 *  (localStorage for instant effect; mirrored to the profile when signed in). */
import { useEffect, useState } from "react";
import {
  getProfile,
  putProfile,
  telegramLinkCode,
  telegramUnlink,
  emailRequest,
  emailVerify,
  emailRemove,
  type Profile,
} from "../app/repo/profile-api.js";
import {
  DEFAULT_NOCK_RPC,
  getNockRpcOverride,
  setNockRpcOverride,
  isPlausibleRpcUrl,
} from "../app/settings.js";
import {
  pushSupported,
  enableBrowserPush,
  disableBrowserPush,
  isBrowserSubscribed,
} from "../app/push.js";
import { useSession } from "./session.js";
import { useLog, LogBox } from "./log.js";

export function Settings() {
  const { nock } = useSession();
  const { state: logState, log, logErr } = useLog("Settings.");

  // Profile keyed by the pkh it was loaded for, so switching/disconnecting the
  // wallet derives a fresh view without resetting state inside an effect.
  const [loaded, setLoaded] = useState<{
    pkh: string;
    profile?: Profile;
    err?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const profile = nock && loaded?.pkh === nock.pkh ? loaded.profile ?? null : null;
  const profileErr = nock && loaded?.pkh === nock.pkh ? loaded.err ?? "" : "";
  const profileLoading = !!nock && loaded?.pkh !== nock.pkh;
  const setProfile = (p: Profile) =>
    nock && setLoaded({ pkh: nock.pkh, profile: p });

  // RPC override works pre-sign-in (pure localStorage).
  const [rpcUrl, setRpcUrl] = useState(() => getNockRpcOverride());

  // Whether THIS browser holds a live push subscription.
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    isBrowserSubscribed().then((on) => {
      if (alive) setPushOn(on);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function togglePush(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (pushOn) {
        await disableBrowserPush();
        setPushOn(false);
        log("Browser notifications disabled on this device.", true);
      } else {
        await enableBrowserPush();
        setPushOn(true);
        log("Browser notifications enabled on this device.", true);
      }
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  // Load the profile once Iris is connected; sync the profile's RPC down when
  // this device has no local override yet (cross-device pickup).
  useEffect(() => {
    if (!nock) return;
    const pkh = nock.pkh;
    let alive = true;
    getProfile()
      .then((p) => {
        if (!alive) return;
        setLoaded({ pkh, profile: p });
        const synced = p.settings?.nockRpcUrl ?? "";
        if (synced && !getNockRpcOverride()) {
          setNockRpcOverride(synced);
          setRpcUrl(synced);
        }
      })
      .catch((e) => {
        if (alive) {
          setLoaded({ pkh, err: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      alive = false;
    };
  }, [nock]);

  async function saveRpc(value: string): Promise<void> {
    const url = value.trim();
    if (url && !isPlausibleRpcUrl(url)) {
      logErr(new Error("Enter an http(s) URL (a grpc-web endpoint with CORS enabled)."));
      return;
    }
    setNockRpcOverride(url || null);
    // Mirror to the profile so other devices pick it up (best-effort).
    if (nock) {
      try {
        setProfile(await putProfile({ settings: { nockRpcUrl: url } }));
      } catch (e) {
        logErr(e);
      }
    }
    log(
      url
        ? `Nockchain RPC set to ${url}. Reloading to apply…`
        : "Nockchain RPC reset to the default. Reloading to apply…",
      true
    );
    setTimeout(() => window.location.reload(), 800);
  }

  async function connectTelegram(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await telegramLinkCode();
      window.open(url, "_blank", "noopener");
      log(
        "Telegram opened — press START in the bot chat, then come back and refresh this page.",
        true
      );
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function disconnectTelegram(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      setProfile(await telegramUnlink());
      log("Telegram disconnected.", true);
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  // Email verification flow state.
  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [codeSentTo, setCodeSentTo] = useState("");

  async function sendEmailCode(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const { address } = await emailRequest(emailInput);
      setCodeSentTo(address);
      log(`Verification code sent to ${address} — enter it below.`, true);
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEmailCode(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      setProfile(await emailVerify(codeInput));
      setCodeSentTo("");
      setCodeInput("");
      setEmailInput("");
      log("Email verified — you'll get swap updates by mail.", true);
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function dropEmail(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      setProfile(await emailRemove());
      log("Email removed.", true);
    } catch (e) {
      logErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggleChannel(channel: "telegram" | "push" | "email"): Promise<void> {
    if (!profile) return;
    const prefs = { ...profile.prefs, [channel]: !(profile.prefs?.[channel] ?? false) };
    try {
      setProfile(await putProfile({ prefs }));
    } catch (e) {
      logErr(e);
    }
  }

  return (
    <section className="panel">
      <h2 className="flow-title">Settings</h2>
      <LogBox state={logState} />

      <h3>Notifications</h3>
      {!nock ? (
        <p className="hint">Connect Iris to manage notifications — they follow your Nockchain wallet.</p>
      ) : profileErr ? (
        <p className="hint">{profileErr}</p>
      ) : profileLoading || profile == null ? (
        <p className="hint">Loading your profile…</p>
      ) : (
        <>
          <p className="hint">
            Get a message on every swap step — claimed, locked, withdrawn, complete,
            refunds — by browser push, Telegram, or email.
          </p>
          <div className="settings-row">
            {pushSupported() ? (
              <button type="button" disabled={busy || pushOn == null} onClick={() => void togglePush()}>
                {pushOn ? "Disable browser notifications" : "Enable browser notifications"}
              </button>
            ) : (
              <span className="hint">
                Browser push unavailable (needs HTTPS + a configured VAPID key; on
                iOS, install the site to your home screen).
              </span>
            )}
          </div>
          <div className="settings-row">
            {profile.telegram ? (
              <>
                <span>
                  Telegram: connected
                  {profile.telegram.username ? ` as @${profile.telegram.username}` : ""}
                </span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={profile.prefs?.telegram ?? false}
                    onChange={() => void toggleChannel("telegram")}
                  />
                  Enabled
                </label>
                <button type="button" disabled={busy} onClick={() => void disconnectTelegram()}>
                  Disconnect
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => void connectTelegram()}>
                Connect Telegram
              </button>
            )}
          </div>
          {profile.email?.verified ? (
            <div className="settings-row">
              <span>Email: {profile.email.address}</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={profile.prefs?.email ?? false}
                  onChange={() => void toggleChannel("email")}
                />
                Enabled
              </label>
              <button type="button" disabled={busy} onClick={() => void dropEmail()}>
                Remove
              </button>
            </div>
          ) : codeSentTo ? (
            <div className="lookup-row">
              <input
                placeholder={`6-digit code sent to ${codeSentTo}`}
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
              />
              <button type="button" disabled={busy} onClick={() => void confirmEmailCode()}>
                Verify
              </button>
            </div>
          ) : (
            <div className="lookup-row">
              <input
                type="email"
                placeholder="you@example.com"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
              />
              <button type="button" disabled={busy} onClick={() => void sendEmailCode()}>
                Add email
              </button>
            </div>
          )}
        </>
      )}

      <h3>Nockchain RPC</h3>
      <p className="hint">
        Point the app at your own node. Must be a grpc-web endpoint with browser
        CORS enabled (a raw node port won't work). Default: {DEFAULT_NOCK_RPC}
      </p>
      <div className="lookup-row">
        <input
          placeholder={DEFAULT_NOCK_RPC}
          value={rpcUrl}
          onChange={(e) => setRpcUrl(e.target.value)}
        />
        <button type="button" onClick={() => void saveRpc(rpcUrl)}>
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setRpcUrl("");
            void saveRpc("");
          }}
        >
          Reset to default
        </button>
      </div>
    </section>
  );
}
