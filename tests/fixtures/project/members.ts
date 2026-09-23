import { UserModel } from './models';

/** A member is referenced by name: as a property access here, and as a string literal below. */
export function touchMember(user: UserModel): string {
    const viaAccess = user.nickname;
    UserModel.query().where('nickname', 'x');
    return viaAccess;
}
