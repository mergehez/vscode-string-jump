import { TopicModel, UserModel } from './models';
import { ModelQueryBuilderContract } from './orm';

/** Stands in for `preload('topics', (query) => …)`: the callback runs on the related model's builder. */
export function withTopics(callback: (builder: ModelQueryBuilderContract<typeof TopicModel>) => void): void {
    callback(TopicModel.query());
}

export function userQueries(): void {
    UserModel.query().where('receiver_id', 1);
    UserModel.query().where('id', 1).orderBy('id', 'asc');
    UserModel.query().preload('creator');
    UserModel.query().preload('creator', ['id', 'username', 'avatar']);
    UserModel.query().preload('topics');
    UserModel.query().where('not_a_column', 1);

    withTopics((topics) => {
        topics.where('title', 'x');
        topics.orderBy('user_id', 'desc');
    });

    UserModel.find(1);
}
