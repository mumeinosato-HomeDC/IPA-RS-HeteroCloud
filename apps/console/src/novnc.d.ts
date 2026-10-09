declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    focus(): void;
    disconnect(): void;
    addEventListener(type: string, listener: (event: CustomEvent) => void): void;
  }
}
