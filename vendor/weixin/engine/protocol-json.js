

export function parseProtocolJson(text) {
    return JSON.parse(text, (_key, value, context) => {
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
            if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error('Unsafe platform integer');
            return context.source;
        }
        return value;
    });
}
