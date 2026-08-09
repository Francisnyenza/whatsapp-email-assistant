import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { MessageRepository } from '../src/repositories/message.repository.js';

/**
 * A number nobody proved is a number nobody sends to.
 *
 * This is the seal on the whole verification flow, and it is asserted against
 * real rows rather than a stub, because the property that matters is a *column*:
 * `phone_verified` existed from the first migration and was read by no code, so
 * an unverified number was indistinguishable from a verified one everywhere it
 * mattered.
 *
 * What that meant in practice is worth stating plainly, because it is not a
 * theoretical hole. This number decides where a user's private email is
 * delivered. A typo at signup sent someone's inbox summaries to a stranger's
 * phone, with nothing to catch it. And because the column is `UNIQUE`, claiming
 * a number you did not own also squatted it — the real owner could then never
 * register, and their inbound messages resolved to the squatter's mailbox.
 *
 * `findDeliveryContext` is the one place every notification path reads the
 * number from, which is why the check lives there rather than at each call site.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('delivering to an unverified number (real database)', () => {
  let prisma: PrismaClient;
  let messages: MessageRepository;

  const userId = randomUUID();
  const phone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });
    messages = new MessageRepository(service as never);

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        status: 'active',
        phoneNumber: phone,
      },
    });
    await scopedTx(prisma, userId, async (tx) => {
      await (tx as PrismaClient).userPreference.create({ data: { userId } });
    });
  });

  beforeEach(async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { phoneNumber: phone, phoneVerified: false },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('reads as no number at all while unverified', async () => {
    // Every notification path guards on `user?.phoneNumber`, so returning null
    // here is what stops all of them at once — rather than adding a second
    // check to each and waiting for the one that gets forgotten.
    const { user } = await messages.findDeliveryContext(userId);

    expect(user).not.toBeNull();
    expect(user!.phoneNumber).toBeNull();
  });

  it('reads as itself once verified', async () => {
    await prisma.user.update({ where: { id: userId }, data: { phoneVerified: true } });

    const { user } = await messages.findDeliveryContext(userId);

    expect(user!.phoneNumber).toBe(phone);
  });

  it('still returns everything else, so nothing downstream has to cope with a gap', async () => {
    const { user, preferences } = await messages.findDeliveryContext(userId);

    expect(user!.timezone).toBeTruthy();
    expect(user!.locale).toBeTruthy();
    expect(preferences).not.toBeNull();
  });

  it('is null for a user with no number at all, verified flag or not', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { phoneNumber: null, phoneVerified: true },
    });

    const { user } = await messages.findDeliveryContext(userId);
    expect(user!.phoneNumber).toBeNull();
  });
});
