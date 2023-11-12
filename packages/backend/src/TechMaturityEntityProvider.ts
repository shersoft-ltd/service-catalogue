import {
  DeferredEntity,
  EntityProvider,
  EntityProviderConnection,
  locationSpecToLocationEntity,
} from '@backstage/plugin-catalog-node';
import { Config } from '@backstage/config';
import { Logger } from 'winston';
import { TaskRunner } from '@backstage/backend-tasks';
import * as uuid from 'uuid';
import {
  CloudFormationClient,
  paginateDescribeStacks,
  StackStatus,
} from '@aws-sdk/client-cloudformation';
import {
  Account,
  OrganizationsClient,
  paginateListAccounts,
} from '@aws-sdk/client-organizations';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import pMap from 'p-map';

const IN_SCOPE_STACK_STATUSES: StackStatus[] = [
  StackStatus.CREATE_COMPLETE,
  StackStatus.CREATE_FAILED,
  StackStatus.CREATE_IN_PROGRESS,
  StackStatus.DELETE_FAILED,
  StackStatus.DELETE_IN_PROGRESS,
  StackStatus.IMPORT_COMPLETE,
  StackStatus.IMPORT_IN_PROGRESS,
  StackStatus.IMPORT_ROLLBACK_COMPLETE,
  StackStatus.IMPORT_ROLLBACK_FAILED,
  StackStatus.IMPORT_ROLLBACK_IN_PROGRESS,
  StackStatus.REVIEW_IN_PROGRESS,
  StackStatus.ROLLBACK_COMPLETE,
  StackStatus.ROLLBACK_FAILED,
  StackStatus.ROLLBACK_IN_PROGRESS,
  StackStatus.UPDATE_COMPLETE,
  StackStatus.UPDATE_COMPLETE_CLEANUP_IN_PROGRESS,
  StackStatus.UPDATE_FAILED,
  StackStatus.UPDATE_IN_PROGRESS,
  StackStatus.UPDATE_ROLLBACK_COMPLETE,
  StackStatus.UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS,
  StackStatus.UPDATE_ROLLBACK_FAILED,
  StackStatus.UPDATE_ROLLBACK_IN_PROGRESS,
];

export class TechMaturityEntityProvider implements EntityProvider {
  /**
   * Initialise a [TechMaturityEntityProvider] using the configuration in your
   * app-config.*.yaml.
   *
   * In `options`, the `sourceRoleArn` is the AWS IAM role that should be
   * assumed to read information from each account. This role will be in your
   * management account. The `destinationRoleName` is a role that's expected to
   * exist in every AWS account. The `sourceRoleArn` must be able to assume it.
   *
   * We'll search for CloudFormation stacks in each of the `regions`.
   *
   * @param config
   * @param options
   */
  public static fromConfig(
    config: Config,
    options: {
      logger: Logger;
      schedule: TaskRunner;
      overrideOrganizationsClientFactory?: () => OrganizationsClient;
      overrideCloudFormationClientFactory?: (accountId: string) => {
        cloudFormationClient: CloudFormationClient;
        roleArn: string;
      };
    },
  ): TechMaturityEntityProvider {
    const sourceRoleArn = config.getString(
      'catalog.providers.techMaturity.sourceRoleArn',
    );
    const destinationRoleName = config.getString(
      'catalog.providers.techMaturity.destinationRoleName',
    );
    const regions = config.getStringArray(
      'catalog.providers.techMaturity.regions',
    );

    const topLevelCredentials = options.overrideOrganizationsClientFactory
      ? void 0
      : fromTemporaryCredentials({
          params: {
            RoleArn: sourceRoleArn,
          },
        });

    return new TechMaturityEntityProvider(
      options.logger,
      options.schedule,
      regions,
      options.overrideOrganizationsClientFactory ||
        (() =>
          new OrganizationsClient({
            credentials: topLevelCredentials,
          })),
      options.overrideCloudFormationClientFactory ||
        ((accountId: string, region: string) => {
          const roleArn = `arn:aws:iam::${accountId}:role/${destinationRoleName}`;

          return {
            cloudFormationClient: new CloudFormationClient({
              credentials: fromTemporaryCredentials({
                masterCredentials: topLevelCredentials,
                params: {
                  RoleArn: `arn:aws:iam::${accountId}:role/${destinationRoleName}`,
                },
              }),
              region,
            }),
            roleArn,
          };
        }),
    );
  }

  public static CloudFormationStackLocationType = 'cloudformation-stack';

  private logger: Logger;

  private connection: EntityProviderConnection | undefined;

  private scheduleFn: () => Promise<void>;

  private organizationsClient: OrganizationsClient;

  constructor(
    logger: Logger,
    taskRunner: TaskRunner,
    private readonly regions: string[],
    organizationsClientFactory: () => OrganizationsClient,
    private readonly cloudFormationClientFactory: (
      accountId: string,
      region: string,
    ) => {
      cloudFormationClient: CloudFormationClient;
      roleArn: string;
    },
  ) {
    this.logger = logger.child({
      target: this.getProviderName(),
    });

    this.scheduleFn = this.createScheduleFn(taskRunner);

    this.organizationsClient = organizationsClientFactory();
  }

  getProviderName(): string {
    return 'tech-maturity-provider';
  }

  async connect(connection: EntityProviderConnection) {
    this.connection = connection;
    return await this.scheduleFn();
  }

  private createScheduleFn(taskRunner: TaskRunner) {
    return async () => {
      const taskId = `${this.getProviderName()}:refresh`;
      return taskRunner.run({
        id: taskId,
        fn: async () => {
          const logger = this.logger.child({
            class: TechMaturityEntityProvider.prototype.constructor.name,
            taskId,
            taskInstanceId: uuid.v4(),
          });
          try {
            await this.refresh();
          } catch (error) {
            logger.error(
              `${this.getProviderName()} refresh failed, ${error}`,
              error,
            );
          }
        },
      });
    };
  }

  private async refresh(): Promise<void> {
    const listAccounts = paginateListAccounts(
      { client: this.organizationsClient },
      {},
    );
    const accounts: Account[] = [];

    for await (const result of listAccounts) {
      result.Accounts?.forEach(account => accounts.push(account));
    }

    this.logger.info('loaded AWS accounts from the organization', {
      numAccounts: accounts.length,
    });

    const stacks: DeferredEntity[] = [];

    await pMap(
      accounts,
      async account => {
        try {
          for (const region of this.regions) {
            const { cloudFormationClient, roleArn } =
              this.cloudFormationClientFactory(account.Id!, region);

            const describeStacks = paginateDescribeStacks(
              { client: cloudFormationClient },
              {},
            );

            for await (const result of describeStacks) {
              for (const stack of result.Stacks || []) {
                if (!IN_SCOPE_STACK_STATUSES.includes(stack.StackStatus!)) {
                  this.logger.debug(
                    "not considering stack because it's not in a status we accept",
                    { account, stack },
                  );

                  return;
                }

                stacks.push({
                  locationKey: this.getProviderName(),
                  entity: locationSpecToLocationEntity({
                    location: {
                      type: TechMaturityEntityProvider.CloudFormationStackLocationType,
                      target: `https://shersoft.cloud?accountId=${
                        account.Id
                      }&roleArn=${encodeURIComponent(
                        roleArn,
                      )}&stackName=${encodeURIComponent(stack.StackName!)}`,
                    },
                  }),
                });

                this.logger.debug('discovered CloudFormation Stack', {
                  account,
                  stack,
                });
              }
            }
          }

          this.logger.info('processed AWS account', { account });
        } catch (err) {
          this.logger.warn('failed to detect resources in AWS account', {
            account,
          });
        }
      },
      { concurrency: 3 },
    );

    await this.connection?.applyMutation({
      type: 'full',
      entities: stacks,
    });
  }
}
