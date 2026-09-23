/** A string in a position typed as this union jumps to the union member that declares it. */
export type Keys = 'key0' | 'key1';

export function useKey(key: Keys): string {
    return key;
}

export const first = useKey('key0');
export const second = useKey('key1');
// @ts-expect-error - 'key2' is not assignable to type 'Keys'
export const unknownKey = useKey('key2');
export const noKey = 'not-a-key';

export const messages = {
    greeting: 'Hello',
    farewell: 'Bye',
};

export type MessageKey = keyof typeof messages;
export type MessageKeyOrObject = MessageKey | { en?: string };

export function say(key: MessageKeyOrObject): string {
    return typeof key === 'string' ? key : (key.en ?? '');
}

export const hello = say('greeting');
