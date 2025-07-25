import { computeTrustId, JsonTrustStore } from '@btps/sdk/trust';
import { BtpsServerLightweightFactory } from '@btps/sdk/server/core';
import { BTPAgentArtifact } from '@btps/sdk/server';

const TrustStore = new JsonTrustStore({
  connection: `${process.cwd()}/.well-known/btps-trust.json`,
  entityName: 'trusted_senders',
});

const useTlsCerts = process.env.USE_TLS ?? 'false';

if (useTlsCerts === 'true') {
  console.log('using tls cert and key');
}

const mockedUser = {
  senderId: 'finance$ebilladdress.com',
  receiverId: 'finance$ebilladdress.com',
};

console.log(computeTrustId(mockedUser.senderId, mockedUser.receiverId));

const certBundle =
  useTlsCerts === 'false'
    ? {}
    : {
        key: Buffer.from(process.env.TLS_KEY!, 'base64').toString('utf8'),
        cert: Buffer.from(process.env.TLS_CERT!, 'base64').toString('utf8'),
      };

// Using the lightweight factory - BtpsServer is only loaded when create() is called
async function startServer() {
  const BTPsServer = await BtpsServerLightweightFactory.create({
    trustStore: TrustStore,
    options: {
      ...certBundle,
      requestCert: false,
    },
    connectionTimeoutMs: 5000,
  });

  await BTPsServer.start();

  BTPsServer.onIncomingArtifact('Agent', (artifact: BTPAgentArtifact) => {
    console.log('INCOMING AGENT ARTIFACT', JSON.stringify(artifact, null, 2));
  });
}

startServer().catch(console.error);
