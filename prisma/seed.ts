/* eslint-disable no-console */
// =============================================================================
// Seed: demo data for local development and QA.
//
// Roles are created by migration 20261013_shift_breaks_and_roles, so a fresh
// database is usable without this script. This seed adds a demo company, the
// demo shifts (with break schedules) and three demo logins:
//   admin@timechamp.test   / admin123    Super Admin
//   manager@timechamp.test / manager123  Manager
//   user@timechamp.test    / user123     Staff (reports to the manager)
//
// It REFUSES to create those accounts when NODE_ENV=production unless
// SEED_DEMO_DATA=true is also set, because well-known passwords must never
// reach a live system.
// =============================================================================
import { BreakKind, PrismaClient, RoleName } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const PERMISSIONS = [
  'CREATE_USER',
  'UPDATE_USER',
  'DELETE_USER',
  'VIEW_TEAM',
  'VIEW_REPORT',
  'MANAGE_COMPANY',
  'MANAGE_SHIFT',
  'ASSIGN_MEMBER',
  'VIEW_SCREENSHOTS',
  'SEND_CHAT',
];

const ROLE_PERMISSIONS: Record<RoleName, string[]> = {
  SUPER_ADMIN: PERMISSIONS,
  MANAGER: PERMISSIONS.filter((p) => p !== 'MANAGE_COMPANY' && p !== 'MANAGE_SHIFT'),
  USER: [],
};

interface SeedBreak {
  kind: BreakKind;
  startTime: string;
  durationMin: number;
}

async function upsertShift(
  id: string,
  companyId: string,
  name: string,
  start: string,
  end: string,
  breaks: SeedBreak[],
  isDefault = false,
) {
  // Create-only: a shift that already exists (yours, or an earlier seed's under the
  // same id) is never rewritten, and neither are its breaks.
  const shift = await prisma.shift.upsert({
    where: { id },
    update: {},
    create: {
      id,
      companyId,
      name,
      start,
      end,
      isDefault,
      workDays: [1, 2, 3, 4, 5, 6],
      // 3.1: up to 3 minutes over a break is simply break time.
      overrunGraceMin: 3,
    },
  });
  for (const b of breaks) {
    await prisma.shiftBreak.upsert({
      where: { shiftId_kind: { shiftId: shift.id, kind: b.kind } },
      update: {},
      create: {
        shiftId: shift.id,
        kind: b.kind,
        startTime: b.startTime,
        durationMin: b.durationMin,
        windowBeforeMin: 30,
        windowAfterMin: 60,
        // 3.1: morning and evening breaks can be skipped, lunch cannot.
        allowSkip: b.kind !== 'LUNCH',
      },
    });
  }
  return shift;
}

async function main() {
  for (const name of Object.keys(ROLE_PERMISSIONS) as RoleName[]) {
    const permissions = ROLE_PERMISSIONS[name];
    await prisma.role.upsert({
      where: { name },
      update: { permissions },
      create: { name, permissions },
    });
  }

  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO_DATA !== 'true') {
    console.log('Production: roles ensured, demo company/shifts/accounts skipped.');
    return;
  }

  // A database that already has real people is never given demo accounts with
  // published passwords, whatever NODE_ENV says (a server .env often still reads
  // "development"). SEED_DEMO_DATA=true overrides, for a deliberate demo.
  const demoEmails = ['admin@timechamp.test', 'manager@timechamp.test', 'user@timechamp.test'];
  const realUsers = await prisma.user.count({ where: { email: { notIn: demoEmails } } });
  if (realUsers > 0 && process.env.SEED_DEMO_DATA !== 'true') {
    console.log(`Roles ensured. ${realUsers} real account(s) found, so demo data was skipped.`);
    return;
  }

  const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 12);

  const company = await prisma.company.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000c1' },
    update: {},
    create: { id: '00000000-0000-0000-0000-0000000000c1', name: 'RhythmRX' },
  });

  const general = await upsertShift(
    '00000000-0000-0000-0000-0000000000d1',
    company.id,
    'General',
    '09:30',
    '18:30',
    [
      { kind: 'MORNING', startTime: '11:00', durationMin: 15 },
      { kind: 'LUNCH', startTime: '13:00', durationMin: 30 },
      { kind: 'EVENING', startTime: '16:00', durationMin: 15 },
    ],
    true,
  );
  await upsertShift('00000000-0000-0000-0000-0000000000d2', company.id, 'Early', '07:00', '16:00', [
    { kind: 'MORNING', startTime: '09:00', durationMin: 15 },
    { kind: 'LUNCH', startTime: '11:30', durationMin: 30 },
    { kind: 'EVENING', startTime: '14:00', durationMin: 15 },
  ]);

  const roleId = async (name: RoleName) =>
    (await prisma.role.findUniqueOrThrow({ where: { name } })).id;

  const admin = await prisma.user.upsert({
    where: { email: 'admin@timechamp.test' },
    update: {},
    create: {
      email: 'admin@timechamp.test',
      passwordHash: await bcrypt.hash('admin123', saltRounds),
      firstName: 'Praveen',
      lastName: '(Super Admin)',
      roleId: await roleId('SUPER_ADMIN'),
      companyId: company.id,
      shiftStart: '09:30',
      shiftEnd: '18:30',
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: 'manager@timechamp.test' },
    update: {},
    create: {
      email: 'manager@timechamp.test',
      passwordHash: await bcrypt.hash('manager123', saltRounds),
      firstName: 'Maya',
      lastName: 'Reddy',
      roleId: await roleId('MANAGER'),
      department: 'Engineering',
      managerId: admin.id,
      companyId: company.id,
      shiftStart: '09:30',
      shiftEnd: '18:30',
    },
  });

  await prisma.user.upsert({
    where: { email: 'user@timechamp.test' },
    update: {},
    create: {
      email: 'user@timechamp.test',
      passwordHash: await bcrypt.hash('user123', saltRounds),
      firstName: 'Praveen',
      lastName: 'Kumar',
      roleId: await roleId('USER'),
      department: 'Engineering',
      managerId: manager.id,
      companyId: company.id,
      shiftStart: '09:30',
      shiftEnd: '18:30',
    },
  });

  console.log('Seed complete:', {
    superAdmin: admin.email,
    manager: manager.email,
    defaultShift: general.name,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
