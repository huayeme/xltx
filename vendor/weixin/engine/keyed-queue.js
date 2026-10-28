
export class KeyedSerialQueue {
    operations = new Map();
    keys() {
        return [...this.operations.keys()];
    }
    async run(key, operation) {
        const previous = this.operations.get(key) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(operation);
        const tracked = result.then(() => undefined, () => undefined);
        this.operations.set(key, tracked);
        try {
            return await result;
        }
        finally {
            if (this.operations.get(key) === tracked)
                this.operations.delete(key);
        }
    }
}
