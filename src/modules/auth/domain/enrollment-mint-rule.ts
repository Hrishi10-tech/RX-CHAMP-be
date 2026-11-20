import { User } from '@modules/users/domain/entities/user.entity';
import {
  ActorContext,
  UserAccessService,
} from '@modules/users/domain/services/user-access.service';

const access = new UserAccessService();

/**
 * Who may hold an enrollment token for `target` (4.0, docs/4.0/SPEC.md 1.2, 5.3):
 * whoever may change that person (the organisation's Admin for its Managers and
 * Staff, a Super Admin also for its Admin, the Super Manager for Staff), never the
 * person themselves: the token is a 365-day credential, and minting one for
 * yourself would outlive a sign-out key or a blocked password.
 *
 * Asked twice (3.6, F-02): when the token is minted, and again when it is
 * exchanged, so a token stops working once its minter could no longer have asked
 * for it.
 */
export function mayMintEnrollmentFor(minter: ActorContext, target: User): boolean {
  if (target.id === minter.id) return false;
  return access.ownsTarget(minter, target);
}
