import type {
  CommandInvokedEventPayload,
  InteractionCreatedEventPayload,
} from "../contract/events";
import type { UserSummary } from "../contract/primitives";
import type { StoredComponent } from "./interaction-policy";
import { parseStoredComponents } from "./bot-effects";

export interface CommandInvokedPersistedPayload {
  invocation: {
    invocation_id: string;
    status: string;
    created_at: string;
  };
  command_id?: string;
  actor_user_id: string;
  command_name: string;
  invoked_name?: string;
}

export interface InteractionCreatedPersistedPayload {
  interaction: {
    interaction_id: string;
    status: string;
    created_at: string;
  };
  command_id?: string;
  actor_user_id: string;
  message_id: string;
  component_id: string;
}

export function buildCommandInvokedPersistedPayload(input: {
  invocationId: string;
  createdAt: string;
  commandId: string;
  actorUserId: string;
  commandName: string;
  invokedName: string;
}): CommandInvokedPersistedPayload {
  return {
    invocation: {
      invocation_id: input.invocationId,
      status: "pending",
      created_at: input.createdAt,
    },
    command_id: input.commandId,
    actor_user_id: input.actorUserId,
    command_name: input.commandName,
    invoked_name: input.invokedName,
  };
}

export function projectCommandInvokedWirePayload(
  persisted: CommandInvokedPersistedPayload,
  actor: UserSummary,
): CommandInvokedEventPayload {
  return {
    invocation: persisted.invocation,
    command_id: persisted.command_id,
    command_name: persisted.invoked_name || persisted.command_name,
    actor,
  };
}

export function buildInteractionCreatedPersistedPayload(input: {
  interactionId: string;
  createdAt: string;
  commandId: string;
  actorUserId: string;
  messageId: string;
  componentId: string;
}): InteractionCreatedPersistedPayload {
  return {
    interaction: {
      interaction_id: input.interactionId,
      status: "pending",
      created_at: input.createdAt,
    },
    command_id: input.commandId,
    actor_user_id: input.actorUserId,
    message_id: input.messageId,
    component_id: input.componentId,
  };
}

export function resolveComponentLabelFromJson(
  componentsJson: string,
  componentId: string,
): string | null {
  const components = parseStoredComponents(componentsJson) as StoredComponent[];
  const component = components.find((item) => item.component_id === componentId);
  if (!component) return null;
  const label = component.label;
  return typeof label === "string" && label.length > 0 ? label : null;
}

export function projectInteractionCreatedWirePayload(
  persisted: InteractionCreatedPersistedPayload,
  actor: UserSummary,
  componentLabel: string | null,
): InteractionCreatedEventPayload {
  return {
    interaction: persisted.interaction,
    command_id: persisted.command_id,
    actor,
    ...(componentLabel ? { component_label: componentLabel } : {}),
  };
}
