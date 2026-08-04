/**
 * Development seed.
 *
 * Creates one organization, one user with a connected-looking mailbox, and a
 * small amount of mail so the dashboard has something to render. It is
 * idempotent — running it twice leaves the same data, not duplicates.
 *
 * Deliberately absent: real OAuth tokens. The token columns are filled with
 * clearly-fake bytes so nothing here resembles a working credential, and any
 * code that tries to use them fails loudly rather than reaching a real mailbox.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { PrismaClient } from '../generated/client/index.js';

// The seed runs outside the Prisma CLI, which is what would otherwise load the
// monorepo's root .env for us.
loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  quiet: true,
});

const prisma = new PrismaClient();

const FAKE_TOKEN = Buffer.from('SEED-NOT-A-REAL-TOKEN');
const DEMO_EMAIL = 'demo@example.com';

function contentHash(subject: string, body: string): string {
  return createHash('sha256').update(`${subject}\n${body}`).digest('hex');
}

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'demo-org' },
    update: {},
    create: { name: 'Demo Organization', slug: 'demo-org', planTier: 'pro' },
  });

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      fullName: 'Demo User',
      // Password login is disabled for the seed user; sign in via the dev OAuth
      // stub instead. A seeded password hash is a credential nobody rotates.
      passwordHash: null,
      status: 'active',
      emailVerified: true,
      phoneNumber: '+254700000000',
      phoneVerified: true,
      locale: 'en',
      timezone: 'Africa/Nairobi',
    },
  });

  await prisma.orgMembership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: {},
    create: { organizationId: org.id, userId: user.id, role: 'owner' },
  });

  await prisma.userPreference.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      notificationMode: 'instant',
      signature: '— Demo User\nSent from WhatsApp',
      language: 'en',
    },
  });

  await prisma.subscription.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      planTier: 'pro',
      status: 'active',
      maxEmailAccounts: 5,
      maxWhatsAppPerDay: 500,
      maxAiTokensPerDay: 200_000,
      maxAutomationRules: 25,
      attachmentSizeLimitMb: 25,
    },
  });

  const account = await prisma.emailAccount.upsert({
    where: {
      userId_provider_providerAccountId: {
        userId: user.id,
        provider: 'gmail',
        providerAccountId: 'seed-gmail-account',
      },
    },
    update: {},
    create: {
      userId: user.id,
      provider: 'gmail',
      emailAddress: DEMO_EMAIL,
      displayName: 'Demo Gmail',
      status: 'active',
      providerAccountId: 'seed-gmail-account',
      accessTokenCipher: FAKE_TOKEN,
      accessTokenDek: FAKE_TOKEN,
      refreshTokenCipher: FAKE_TOKEN,
      refreshTokenDek: FAKE_TOKEN,
      tokenKeyVersion: 1,
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      isPrimary: true,
      syncCursor: '1',
    },
  });

  const samples = [
    {
      from: 'sarah.chen@acme.com',
      fromName: 'Sarah Chen',
      subject: 'Q3 sales report — need it before Friday',
      body: 'Hi, could you send over the Q3 sales report before Friday? The board meets Monday.',
      priority: 'high' as const,
      category: 'work' as const,
      summary: 'Sarah needs the Q3 sales report before Friday for a Monday board meeting.',
      requiresReply: true,
    },
    {
      from: 'billing@cloudvendor.io',
      fromName: 'CloudVendor Billing',
      subject: 'Invoice #INV-2291 — $1,240.00 due 12 Aug',
      body: 'Your invoice INV-2291 for $1,240.00 is due on 12 August 2026.',
      priority: 'normal' as const,
      category: 'invoice' as const,
      summary: 'Invoice INV-2291 for $1,240.00 is due 12 August.',
      requiresReply: false,
    },
    {
      from: 'news@techdigest.com',
      fromName: 'Tech Digest',
      subject: 'This week in engineering',
      body: 'The five stories our editors thought mattered this week.',
      priority: 'low' as const,
      category: 'newsletter' as const,
      summary: 'Weekly engineering newsletter.',
      requiresReply: false,
    },
  ];

  for (const [i, sample] of samples.entries()) {
    const providerThreadId = `seed-thread-${i}`;
    const providerMessageId = `seed-message-${i}`;
    const receivedAt = new Date(Date.now() - (i + 1) * 3_600_000);

    const thread = await prisma.emailThread.upsert({
      where: { accountId_providerThreadId: { accountId: account.id, providerThreadId } },
      update: {},
      create: {
        userId: user.id,
        accountId: account.id,
        providerThreadId,
        subject: sample.subject,
        lastMessageAt: receivedAt,
        participantAddresses: [sample.from, DEMO_EMAIL],
      },
    });

    const message = await prisma.emailMessage.upsert({
      where: { accountId_providerMessageId: { accountId: account.id, providerMessageId } },
      update: {},
      create: {
        userId: user.id,
        accountId: account.id,
        threadId: thread.id,
        providerMessageId,
        messageIdHeader: `<${randomUUID()}@seed.example.com>`,
        references: [],
        subject: sample.subject,
        fromAddress: sample.from,
        fromName: sample.fromName,
        toAddresses: [DEMO_EMAIL],
        ccAddresses: [],
        bccAddresses: [],
        sentAt: receivedAt,
        receivedAt,
        snippet: sample.body.slice(0, 200),
        contentHash: contentHash(sample.subject, sample.body),
        sizeBytes: sample.body.length,
      },
    });

    await prisma.messageAnalysis.upsert({
      where: { emailMessageId: message.id },
      update: {},
      create: {
        userId: user.id,
        emailMessageId: message.id,
        summary: sample.summary,
        bulletSummary: [sample.summary],
        category: sample.category,
        priority: sample.priority,
        urgencyScore: sample.priority === 'high' ? 0.8 : 0.2,
        spamScore: 0.01,
        language: 'en',
        requiresReply: sample.requiresReply,
        suggestedReplies: sample.requiresReply
          ? ['On it — sending today.', 'Can I get until Monday?']
          : [],
        modelProvider: 'seed',
        model: 'seed',
      },
    });

    await prisma.contact.upsert({
      where: { userId_emailAddress: { userId: user.id, emailAddress: sample.from } },
      update: {},
      create: {
        userId: user.id,
        emailAddress: sample.from,
        displayName: sample.fromName,
        messagesReceived: 1,
        isVip: sample.category === 'work',
      },
    });
  }

  console.warn(`Seeded org ${org.slug}, user ${user.email}, ${samples.length} messages.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
