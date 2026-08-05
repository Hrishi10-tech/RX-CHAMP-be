const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
(async () => {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
  const u = await prisma.user.upsert({
    where: { email: 'verify-flow@local.test' },
    update: { passwordHash: await bcrypt.hash('Verify@123', 12), status: 'ACTIVE' },
    create: {
      email: 'verify-flow@local.test',
      passwordHash: await bcrypt.hash('Verify@123', 12),
      firstName: 'Verify', lastName: 'Flow', name: 'Verify Flow',
      roleId: role.id, status: 'ACTIVE',
    },
  });
  console.log('created', u.email);
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
