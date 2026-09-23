import { BaseModel, BelongsTo } from './orm';

export class TopicModel extends BaseModel {
    declare id: number;
    declare title: string;
    declare user_id: number;
}

export class UserModel extends BaseModel {
    declare id: number;
    declare username: string;
    declare avatar: string;
    declare receiver_id: number;

    declare creator: BelongsTo<typeof UserModel>;
    declare topics: BelongsTo<typeof TopicModel>;
    declare nickname: string;
}
