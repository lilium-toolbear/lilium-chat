import type { ChatChannelHost } from "../host";

export async function dispatchBotRoutes(host: ChatChannelHost, request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/internal/command-binding-update") {
    return host.handleCommandBindingUpdate(request);
  }
  if (url.pathname === "/internal/channel-commands") {
    return host.handleChannelCommands(request);
  }

  return null;
}
