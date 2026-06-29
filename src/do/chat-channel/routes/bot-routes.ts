import type { ChatChannelHost } from "../host";

export async function dispatchBotRoutes(host: ChatChannelHost, request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/internal/command-binding-update") {
    return host.handleCommandBindingUpdate(request);
  }
  if (url.pathname === "/internal/channel-commands") {
    return host.handleChannelCommands(request);
  }
  if (url.pathname === "/internal/command-manifest") {
    return host.handleCommandManifest(request);
  }
  if (url.pathname === "/internal/command-invoke") {
    return host.handleCommandInvoke(request);
  }

  return null;
}
