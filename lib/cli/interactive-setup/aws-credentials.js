'use strict';

const chalk = require('chalk');
const _ = require('lodash');
const inquirer = require('@serverless/utils/inquirer');
const memoizee = require('memoizee');

const AWS = require('aws-sdk');

const awsCredentials = require('../../plugins/aws/utils/credentials');
const { confirm } = require('./utils');
const openBrowser = require('../../utils/openBrowser');
const ServerlessError = require('../../serverless-error');

const isValidAwsAccessKeyId = RegExp.prototype.test.bind(/^[A-Z0-9]{10,}$/);
const isValidAwsSecretAccessKey = RegExp.prototype.test.bind(/^[a-zA-Z0-9/+]{10,}$/);
const { getPlatformClientWithAccessKey } = require('@serverless/dashboard-plugin/lib/clientUtils');

const CREDENTIALS_SETUP_CHOICE = {
  LOCAL: '_local',
  CREATE_PROVIDER: '_create_provider_',
  SKIP: '_skip_',
};

const getProviderLinkUid = (app, service) => `appName|${app}|serviceName|${service}`;

const getSdkInstance = memoizee(
  async (orgName) => {
    return getPlatformClientWithAccessKey(orgName);
  },
  { promise: true }
);

// TODO: TESTS
const getOrgUidByName = memoizee(
  async (orgName) => {
    const sdk = await getSdkInstance(orgName);
    let organization;
    try {
      organization = await sdk.organizations.get({ orgName });
    } catch (err) {
      throw new ServerlessError(
        `Could not access details about your organization in Dashboard: ${err.message}`,
        'CANNOT_GET_ORGANIZATION_DETAILS'
      );
    }
    return organization.orgUid;
  },
  { promise: true }
);

// TODO: TESTS
const getProviders = memoizee(
  async (orgName) => {
    const sdk = await getSdkInstance(orgName);
    const orgUid = await getOrgUidByName(orgName);
    let providers;
    try {
      providers = await sdk.getProviders(orgUid);
    } catch (err) {
      throw new ServerlessError(
        `Could not access details about your organization's providers in Dashboard: ${err.message}`,
        'CANNOT_GET_PROVIDERS_DETAILS'
      );
    }
    return providers.result;
  },
  {
    promise: true,
  }
);

const awsAccessKeyIdInput = async () =>
  (
    await inquirer.prompt({
      message: 'AWS Access Key Id:',
      type: 'input',
      name: 'accessKeyId',
      validate: (input) => {
        if (isValidAwsAccessKeyId(input.trim())) return true;
        return 'AWS Access Key Id seems not valid.\n   Expected something like AKIAIOSFODNN7EXAMPLE';
      },
    })
  ).accessKeyId.trim();

const awsSecretAccessKeyInput = async () =>
  (
    await inquirer.prompt({
      message: 'AWS Secret Access Key:',
      type: 'input',
      name: 'secretAccessKey',
      validate: (input) => {
        if (isValidAwsSecretAccessKey(input.trim())) return true;
        return (
          'AWS Secret Access Key seems not valid.\n' +
          '   Expected something like wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        );
      },
    })
  ).secretAccessKey.trim();

// tODO: TESTS
const credentialsSetupChoice = async (providers) => {
  const hasExistingProviders = Boolean(providers.length);

  const message = hasExistingProviders
    ? 'What credentials do you want to use?'
    : 'No AWS credentials found, what credentials do you want to use?';
  const createAccessRoleName = hasExistingProviders
    ? 'Create a new AWS Access Role provider'
    : 'AWS Access Role (most secure)';

  // TODO: CHANGE FORMATTING FOR EXISTING PROVIDERS
  const credentialsSetupChoices = [
    ...providers.map((provider) => ({
      name: `${provider.alias}(${provider.providerUid})`,
      value: provider.providerUid,
    })),
    { name: createAccessRoleName, value: CREDENTIALS_SETUP_CHOICE.CREATE_PROVIDER },
    { name: 'Local AWS Access Keys', value: CREDENTIALS_SETUP_CHOICE.LOCAL },
  ];

  if (!hasExistingProviders) {
    credentialsSetupChoices.push({ name: 'Skip', value: CREDENTIALS_SETUP_CHOICE.SKIP });
  }

  return (
    await inquirer.prompt({
      message,
      type: 'list',
      name: 'credentialsSetupChoice',
      choices: credentialsSetupChoices,
    })
  ).credentialsSetupChoice;
};

const steps = {
  writeOnSetupSkip: () =>
    process.stdout.write(`\nYou can setup your AWS account later. More details available here:

  http://slss.io/aws-creds-setup\n`),

  shouldSetupAwsCredentials: async () => {
    if (await confirm('Do you want to set them up now?', { name: 'shouldSetupAwsCredentials' })) {
      return true;
    }
    steps.writeOnSetupSkip();
    return false;
  },

  ensureAwsAccount: async () => {
    if (await confirm('Do you have an AWS account?', { name: 'hasAwsAccount' })) return;
    openBrowser('https://portal.aws.amazon.com/billing/signup');
    await inquirer.prompt({
      message: 'Press Enter to continue after creating an AWS account',
      name: 'createAwsAccountPrompt',
    });
  },
  ensureAwsCredentials: async ({ options, configuration }) => {
    const region = options.region || configuration.provider.region || 'us-east-1';
    openBrowser(
      `https://console.aws.amazon.com/iam/home?region=${region}#/users$new?step=final&accessKey&userNames=serverless&permissionType=policies&policies=arn:aws:iam::aws:policy%2FAdministratorAccess`
    );
    await inquirer.prompt({
      message: 'Press Enter to continue after creating an AWS user with access keys',
      name: 'generateAwsCredsPrompt',
    });
  },
  inputAwsCredentials: async () => {
    const accessKeyId = await awsAccessKeyIdInput();
    const secretAccessKey = await awsSecretAccessKeyInput();
    await awsCredentials.saveFileProfiles(new Map([['default', { accessKeyId, secretAccessKey }]]));
    process.stdout.write(
      `\n${chalk.green(
        `AWS credentials saved on your machine at ${chalk.bold(
          process.platform === 'win32' ? '%userprofile%\\.aws\\credentials' : '~/.aws/credentials'
        )}. Go there to change them at any time.`
      )}\n`
    );
  },
  // TODO: TESTS
  handleProviderCreation: async ({ configuration: { org: orgName } }) => {
    const providersUrl = `https://app.serverless.com/${orgName}/settings/providers?source=cli`;
    openBrowser(providersUrl);
    // TODO: CHANGE MESSAGING
    process.stdout.write('Waiting for creation of provider...\n');

    let onEvent;

    const p = new Promise((resolve) => {
      let inquirerPrompt;

      const timeoutDuration = 1000 * 60; // 1 minute
      const showSkipPromptTimeout = setTimeout(() => {
        inquirerPrompt = inquirer.prompt({
          message: '\n Press Enter to continue without setting up provider',
          name: 'skipProviderSetup',
        });

        inquirerPrompt.then(() => resolve(null));
      }, timeoutDuration);

      onEvent = (event) => {
        if (inquirerPrompt) {
          // Disable inquirer prompt asking to skip without setting provider
          inquirerPrompt.ui.close();
        }

        clearTimeout(showSkipPromptTimeout);
        resolve(event);
      };
    });

    // Listen for `provider.created` event to detect creation of new provider
    const sdk = await getSdkInstance(orgName);
    await sdk.connect({
      orgName,
      onEvent,
      filter: {
        events: ['provider.created'],
      },
    });

    let maybeEvent;
    try {
      maybeEvent = await p;
    } finally {
      sdk.disconnect();
    }

    if (maybeEvent) {
      process.stdout.write(`\nDetected creation of provider: "${maybeEvent.data.object.alias}"\n`);
    } else {
      // TODO: ADD MESSAGING THAT YOU SKIPPED SETUP OF THE PROVIDER
    }

    // TODO: CONSIDER IF WE SHOULD CREATE DIRECT LINK for default provider
  },
  // TODO: TESTS
  linkProviderToService: async (app, service, orgName, providerUid) => {
    const sdk = await getSdkInstance(orgName);
    const linkType = 'service';
    const linkUid = getProviderLinkUid(app, service);
    const orgUid = await getOrgUidByName(orgName);
    return sdk.createProviderLink(orgUid, linkType, linkUid, providerUid);
  },
};

module.exports = {
  async isApplicable(context) {
    const { configuration } = context;
    if (
      _.get(configuration, 'provider') !== 'aws' &&
      _.get(configuration, 'provider.name') !== 'aws'
    ) {
      return false;
    }
    if (new AWS.S3().config.credentials) return false;
    if ((await awsCredentials.resolveFileProfiles()).size) return false;

    // TODO: TESTS
    const orgName = _.get(configuration, 'org');
    if (orgName) {
      const providers = await getProviders(orgName);
      const hasDefaultProvider = providers.some((provider) => provider.isDefault);

      if (hasDefaultProvider) return false;
    }

    return true;
  },
  async run(data) {
    return module.exports.runSteps(data);
  },
  steps,
  runSteps: async (context) => {
    const providers = await getProviders(context.configuration.org);
    const credentialsSetupChoiceAnswer = await credentialsSetupChoice(providers);

    if (credentialsSetupChoiceAnswer === CREDENTIALS_SETUP_CHOICE.CREATE_PROVIDER) {
      try {
        await steps.handleProviderCreation(context);
      } catch (err) {
        throw new ServerlessError(
          `Could not handle setup of a new provider in Dashboard: ${err.message}`,
          'CANNOT_SETUP_NEW_PROVIDER'
        );
      }
      return;
      // TODO: CONSIDER IF WE SHOULD CREATE DIRECT LINK for default provider
    } else if (credentialsSetupChoiceAnswer === CREDENTIALS_SETUP_CHOICE.SKIP) {
      // TODO: Add prompt that you can set it up later - link to docs
      return;
    } else if (credentialsSetupChoiceAnswer === CREDENTIALS_SETUP_CHOICE.LOCAL) {
      await steps.ensureAwsAccount();
      await steps.ensureAwsCredentials(context);
      await steps.inputAwsCredentials();
      return;
    }
    // Otherwise user selected an existing provider

    try {
      await steps.linkProviderToService(
        context.configuration.app,
        context.configuration.service,
        context.configuration.org,
        credentialsSetupChoiceAnswer
      );
    } catch (err) {
      throw new ServerlessError(
        `Could not link the selected provider to your service: ${err.message}`,
        'CANNOT_LINK_EXISTING_PROVIDER'
      );
    }

    return;
  },
};
