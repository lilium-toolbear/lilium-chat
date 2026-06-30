import { describe, expect, it } from "vitest";
import {
  buildCommandInvokedPersistedPayload,
  buildInteractionCreatedPersistedPayload,
  projectCommandInvokedWirePayload,
  projectInteractionCreatedWirePayload,
  resolveComponentLabelFromJson,
} from "../../src/chat/bot-lifecycle-events";

describe("bot-lifecycle-events", () => {
  it("projects command.invoked wire payload with actor and command_name", () => {
    const persisted = buildCommandInvokedPersistedPayload({
      invocationId: "inv-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      commandId: "cmd-1",
      actorUserId: "user-1",
      commandName: "werewolf",
      invokedName: "ww",
    });
    const wire = projectCommandInvokedWirePayload(persisted, {
      user_id: "user-1",
      display_name: "Alice",
      avatar_url: null,
    });
    expect(wire.command_name).toBe("ww");
    expect(wire.actor?.display_name).toBe("Alice");
    expect(wire.invocation.invocation_id).toBe("inv-1");
  });

  it("projects interaction.created wire payload with actor and component_label", () => {
    const persisted = buildInteractionCreatedPersistedPayload({
      interactionId: "int-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      commandId: "cmd-1",
      actorUserId: "user-1",
      messageId: "msg-1",
      componentId: "comp-1",
    });
    const wire = projectInteractionCreatedWirePayload(
      persisted,
      { user_id: "user-1", display_name: "Alice", avatar_url: null },
      "确认",
    );
    expect(wire.component_label).toBe("确认");
    expect(wire.actor?.display_name).toBe("Alice");
  });

  it("resolves component label from stored components json", () => {
    const label = resolveComponentLabelFromJson(
      JSON.stringify([
        {
          component_id: "comp-1",
          kind: "button",
          style: "primary",
          label: "Confirm",
          custom_id: "confirm",
          disabled: false,
        },
      ]),
      "comp-1",
    );
    expect(label).toBe("Confirm");
  });
});
