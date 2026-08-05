/* eslint-disable no-console */
// =============================================================================
// Seed — roles, permissions, the default company/shifts and the three demo
// accounts (admin/manager/user) so the new backend boots with the SAME logins
// the demo used. Passwords are now bcrypt-hashed.
// =============================================================================
import { PrismaClient, RoleName } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Permission catalogue (the spec's RBAC examples + the Time Champ actions).
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

// Which permissions each role gets.
const ROLE_PERMISSIONS: Record<RoleName, string[]> = {
  SUPER_ADMIN: PERMISSIONS, // everything
  ADMIN: PERMISSIONS.filter((p) => p !== 'MANAGE_COMPANY'),
  MANAGER: ['CREATE_USER', 'UPDATE_USER', 'DELETE_USER', 'VIEW_TEAM', 'VIEW_REPORT', 'VIEW_SCREENSHOTS', 'SEND_CHAT'],
  USER: [],
};

async function main() {
  const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 12);

  // --- Roles (permissions stored inline on the role) ---
  for (const name of Object.keys(ROLE_PERMISSIONS) as RoleName[]) {
    const permissions = ROLE_PERMISSIONS[name];
    await prisma.role.upsert({
      where: { name },
      update: { permissions },
      create: { name, permissions },
    });
  }

  // --- Company + shifts (mirrors the demo seed) ---
  const company = await prisma.company.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000c1' },
    update: {},
    create: { id: '00000000-0000-0000-0000-0000000000c1', name: 'RhythmRX' },
  });
  const dayShift = await prisma.shift.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000d1' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000d1',
      companyId: company.id,
      name: 'Day',
      start: '10:00',
      end: '19:00',
    },
  });
  await prisma.shift.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000d2' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000d2',
      companyId: company.id,
      name: 'Early',
      start: '09:30',
      end: '18:30',
    },
  });

  const roleByName = async (name: RoleName) =>
    (await prisma.role.findUniqueOrThrow({ where: { name } })).id;
  const superAdminRole = await roleByName('SUPER_ADMIN');
  const managerRole = await roleByName('MANAGER');
  const userRole = await roleByName('USER');

  // --- Demo accounts (same emails/passwords as the demo) ---
  const admin = await prisma.user.upsert({
    where: { email: 'admin@timechamp.test' },
    update: {},
    create: {
      email: 'admin@timechamp.test',
      passwordHash: await bcrypt.hash('admin123', saltRounds),
      firstName: 'Praveen',
      lastName: '(Super Admin)',
      roleId: superAdminRole,
      companyId: company.id,
      shiftId: dayShift.id,
      shiftStart: '10:00',
      shiftEnd: '19:00',
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
      roleId: managerRole,
      department: 'Engineering',
      companyId: company.id,
      shiftId: dayShift.id,
      shiftStart: '10:00',
      shiftEnd: '19:00',
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
      roleId: userRole,
      department: 'Engineering',
      managerId: manager.id,
      shiftStart: '10:00',
      shiftEnd: '19:00',
    },
  });

  console.log('Seed complete:', { admin: admin.email, manager: manager.email });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
