// Query-builder shapes the resolver recognises: a contract type whose name marks a call's string
// argument as a model column or relation, and relations that name their model through a type argument.

/** A relation, e.g. `creator: BelongsTo<typeof UserModel>`. The resolver reads the type argument. */
export type BelongsTo<TModel extends typeof BaseModel> = {
    readonly relatedModel?: TModel;
};

export type ModelQueryBuilderContract<TModel extends typeof BaseModel> = QueryBuilder<TModel>;

export abstract class BaseModel {
    static query<TSelf extends typeof BaseModel>(this: TSelf): ModelQueryBuilderContract<TSelf> {
        return new QueryBuilder<TSelf>();
    }

    static find<TSelf extends typeof BaseModel>(this: TSelf, key: unknown): Promise<InstanceType<TSelf>> {
        void key;
        return Promise.resolve(undefined as unknown as InstanceType<TSelf>);
    }
}

export class QueryBuilder<TModel extends typeof BaseModel> {
    where(column: string, value: unknown): this {
        void column;
        void value;
        return this;
    }

    orderBy(column: string, direction: string): this {
        void column;
        void direction;
        return this;
    }

    preload(relation: string, columns?: readonly string[]): this {
        void relation;
        void columns;
        return this;
    }
}
