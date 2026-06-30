import { ChatChannelCore } from "./core";
import { ChannelReadMixin } from "./handlers/channel-read";
import { ChannelMixin } from "./handlers/channel";
import { MembershipMixin } from "./handlers/membership";
import { MessageSendMixin } from "./handlers/message-send";
import { MessageMutationMixin } from "./handlers/message-mutation";
import { CommandMixin } from "./handlers/command";
import { InteractionSubmitMixin } from "./handlers/interaction-submit";
import { StatefulSessionMixin } from "./handlers/stateful-session";
import { StreamRegistryMixin } from "./handlers/stream-registry";
import { BotDeliveryMixin } from "./handlers/bot-delivery-result";

const WithChannelRead = ChannelReadMixin(ChatChannelCore);
const WithChannel = ChannelMixin(WithChannelRead);
const WithMembership = MembershipMixin(WithChannel);
const WithMessageSend = MessageSendMixin(WithMembership);
const WithMessageMutation = MessageMutationMixin(WithMessageSend);
const WithCommand = CommandMixin(WithMessageMutation);
const WithStatefulSession = StatefulSessionMixin(WithCommand);
const WithStreamRegistry = StreamRegistryMixin(WithStatefulSession);
const WithInteractionSubmit = InteractionSubmitMixin(WithStreamRegistry);
const ChatChannelComposed = BotDeliveryMixin(WithInteractionSubmit);

export class ChatChannel extends ChatChannelComposed {}
