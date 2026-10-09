import RFB from "@novnc/novnc";
import { useEffect, useRef } from "react";
import type { FlashShellConnectionState } from "@/features/flash/flash-web-shell";

/** The VM's graphical console (VNC over the provider's WebSocket relay, no password needed). */
export function VmVncConsole({
  url,
  onStateChange,
}: {
  url: string;
  onStateChange: (state: FlashShellConnectionState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    onStateChange("connecting");
    const rfb = new RFB(container, url);
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = "#111418";
    let connected = false;
    rfb.addEventListener("connect", () => {
      connected = true;
      onStateChange("connected");
      rfb.focus();
    });
    rfb.addEventListener("disconnect", () => onStateChange(connected ? "closed" : "error"));
    rfb.addEventListener("securityfailure", () => onStateChange("error"));
    return () => {
      rfb.disconnect();
    };
  }, [onStateChange, url]);

  return <div ref={containerRef} style={{ height: 560, background: "#111418" }} />;
}
