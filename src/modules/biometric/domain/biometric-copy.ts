/**
 * Notices for biometric days (3.5). Wording: brief 1.5, COPY_DECK B9 and B10. `at` comes
 * formatted by `time12InZone` ("6:30 PM"), `day` by `leaveDay` ("Mon 9 Nov").
 *
 * 4.0: a missing punch is added by the organisation admin (Attendance), so both notices
 * name them where the deck names the manager, the Super Admin or the Super Manager.
 */

export interface Copy {
  title: string;
  body: string;
}

/** C-822, C-823: to the person. */
export function noCheckoutSelfCopy(i: { day: string; at: string }): Copy {
  return {
    title: `No check-out on ${i.day}`,
    body:
      `If you left after ${i.at}, tell the organisation admin so the punch can be added. ` +
      `No check-out was recorded on ${i.day}, so the day was closed at ${i.at}.`,
  };
}

/** C-903, C-904: to their department's managers (else the organisation admin). */
export function noCheckoutManagerCopy(i: { name: string; day: string; at: string }): Copy {
  return {
    title: `${i.name}: no check-out on ${i.day}`,
    body:
      `${i.name} has no check-out on ${i.day}, so the day was closed at ${i.at}. ` +
      'The organisation admin can add the missing punch in Attendance.',
  };
}
