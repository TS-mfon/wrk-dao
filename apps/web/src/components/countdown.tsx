"use client";

import { useEffect, useState } from "react";
import { formatUtc, settlementClock } from "../lib/model";

export function Countdown({ state, executableAt, serverNow }: { state: unknown; executableAt: unknown; serverNow: number }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    // Anchor to the API/server clock, then advance monotonically. A browser clock set
    // hours ahead cannot prematurely mark a challenge window as elapsed.
    const anchor = performance.now();
    setNow(serverNow);
    const tick = () => setNow(serverNow + Math.floor((performance.now() - anchor) / 1000));
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [serverNow]);
  const clock = settlementClock(state, executableAt, now);
  return <div className={`settlement-clock ${clock.kind}`} data-window={clock.kind}>
    <span className="clock-indicator" aria-hidden="true" />
    <div><span className="clock-value" role="timer">{clock.label}</span>{typeof executableAt === "number" && executableAt > 0 && <span className="clock-deadline">Executable {formatUtc(executableAt)}</span>}</div>
  </div>;
}
