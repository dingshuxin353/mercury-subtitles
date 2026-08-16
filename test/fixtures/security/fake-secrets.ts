export const fakeSecrets = Object.freeze({
  apiToken: ['sk', '-test_', 'a'.repeat(24)].join(''),
  authorization: ['Authorization:', ' Bearer ', 'fixture_', 'b'.repeat(20)].join(''),
  privateKey: ['-----BEGIN ', 'PRIVATE KEY-----', '\nfixture-only'].join(''),
  signedUrl: ['https://example.invalid/object?', 'X-Goog-Signature=', 'c'.repeat(24)].join(''),
  userInfoUrl: ['https://', 'fixture-user', ':fixture-pass', '@example.invalid/object'].join(''),
  gcsSignedUri: ['gs://private-bucket/object', '?X-Goog-Signature=', 'fixture'].join(''),
  creditCode: ['credit-code=', 'd'.repeat(16)].join('')
});
