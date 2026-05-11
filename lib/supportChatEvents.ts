/** Open the floating “Chat with receptionist” widget (see SupportChatWidget). */
export const OPEN_SUPPORT_CHAT_EVENT = "bms-open-support-chat";

/** Panel visibility — used to suppress CC toasts/sounds/bell noise while the user is in chat. */
export const SUPPORT_CHAT_PANEL_STATE_EVENT = "bms-support-chat-panel-state";

export type SupportChatPanelStateDetail = { open: boolean };

export function openSupportChatWidget(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SUPPORT_CHAT_EVENT));
}

export function dispatchSupportChatPanelState(open: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SupportChatPanelStateDetail>(SUPPORT_CHAT_PANEL_STATE_EVENT, { detail: { open } }),
  );
}
