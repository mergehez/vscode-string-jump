import { UserModel } from '../models';

/**
 * The tsconfig excludes this folder, so a program built from that tsconfig never contains this file: only a
 * workspace-wide lookup can see these references.
 */
export function usageOutsideTheProject(user: UserModel): string {
    const viaAccess = user.nickname;
    UserModel.query().where('nickname', 'x');
    return viaAccess;
}
