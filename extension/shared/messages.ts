import { MESSAGE_TYPES } from './constants';

type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

export interface ExtensionMessage<T = unknown> {
    type: MessageType;
    payload?: T;
}

export function createMessage<T>(type: MessageType, payload?: T): ExtensionMessage<T> {
    return { type, payload };
}

export function isMessageOfType(
    message: ExtensionMessage,
    type: MessageType,
): boolean {
    return message?.type === type;
}
