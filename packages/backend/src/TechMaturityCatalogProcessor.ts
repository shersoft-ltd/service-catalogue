import { CatalogProcessor } from '@backstage/plugin-catalog-node';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import {
  CatalogProcessorCache,
  CatalogProcessorEmit,
  CatalogProcessorParser,
  processingResult,
} from '@backstage/plugin-catalog-node';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  paginateListStackResources,
} from '@aws-sdk/client-cloudformation';
import { AwsCredentialIdentityProvider } from '@smithy/types';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { Logger } from 'winston';
import * as yaml from 'yaml';
import * as crypto from 'crypto';
import { TechMaturityEntityProvider } from './TechMaturityEntityProvider';
import { Config } from '@backstage/config';

export class TechMaturityCatalogProcessor implements CatalogProcessor {
  private static AnnotationPrefix = 'shersoft.cloud/';

  // private static ValidResourceStatuses: ResourceStatus[] = [
  //   ResourceStatus.CREATE_COMPLETE,
  //   ResourceStatus.IMPORT_COMPLETE,
  //   ResourceStatus.UPDATE_COMPLETE,
  // ];

  constructor(
    private readonly logger: Logger,
    private readonly topLevelCredentials: AwsCredentialIdentityProvider,
  ) {}

  public static fromConfig(
    logger: Logger,
    config: Config,
  ): TechMaturityCatalogProcessor {
    const sourceRoleArn = config.getString(
      'catalog.providers.techMaturity.sourceRoleArn',
    );

    const topLevelCredentials = fromTemporaryCredentials({
      params: {
        RoleArn: sourceRoleArn,
      },
    });

    return new TechMaturityCatalogProcessor(logger, topLevelCredentials);
  }

  getProcessorName() {
    return 'TechMaturityCatalogProcessor2';
  }

  // readLocation(location: LocationSpec$1, optional: boolean, emit: CatalogProcessorEmit, parser: CatalogProcessorParser, cache: CatalogProcessorCache)

  async readLocation(
    location: LocationSpec,
    _optional: boolean,
    emit: CatalogProcessorEmit,
    _parser: CatalogProcessorParser,
    _cache: CatalogProcessorCache,
  ) {
    if (
      location.type !==
      TechMaturityEntityProvider.CloudFormationStackLocationType
    ) {
      return false;
    }

    const { accountId, roleArn, stackName, region } = JSON.parse(
      location.target,
    );

    const logger = this.logger.child({
      roleArn,
      stackName,
      accountId,
      region,
    });

    logger.info('reading location', {
      location,
    });

    const cloudFormationClient = new CloudFormationClient({
      credentials: fromTemporaryCredentials({
        masterCredentials: this.topLevelCredentials,
        params: {
          RoleArn: roleArn,
        },
      }),
    });

    try {
      const stack = await cloudFormationClient.send(
        new DescribeStacksCommand({ StackName: stackName }),
      );

      if (!stack.Stacks?.[0]?.StackStatus?.includes('COMPLETE')) {
        logger.info("not reading stack as it's not in a supported state", {
          status: stack.Stacks?.[0]?.StackStatus,
        });

        return true;
      }

      const template = await cloudFormationClient.send(
        new GetTemplateCommand({
          StackName: stackName,
        }),
      );

      if (!template.TemplateBody) {
        throw new Error(
          `CloudFormation stack ${stackName} (account = ${accountId}, region = ${region}) missing template body.`,
        );
      }

      const stackResourceName =
        'aws-cfn-' +
        crypto
          .createHash('shake256', { outputLength: 27 })
          .update(Buffer.from(stack.Stacks![0]!.StackId!, 'utf-8'))
          .digest()
          .toString('hex');

      const tags = (stack.Stacks[0].Tags || []).reduce((out, curr) => {
        out[curr.Key!] = curr.Value!;
        return out;
      }, {} as Record<string, string>);

      emit(
        processingResult.entity(location, {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Resource',
          metadata: {
            name: stackResourceName,
            description: `Auto-detected AWS CloudFormation Stack: ${stackName}`,
            annotations: {
              [`${TechMaturityCatalogProcessor.AnnotationPrefix}region`]:
                region,
              [`${TechMaturityCatalogProcessor.AnnotationPrefix}lookedUpWith`]:
                roleArn,
              [`${TechMaturityCatalogProcessor.AnnotationPrefix}accountId`]:
                accountId,
              [`${TechMaturityCatalogProcessor.AnnotationPrefix}cloudFormationStackName`]:
                stackName,
            },
            links: [
              {
                url: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?filteringText=&filteringStatus=active&viewNested=true&stackId=${encodeURIComponent(
                  stack.Stacks![0].StackId!,
                )}`,
                title: 'CloudFormation stack in the AWS console',
              },
            ],
          },
          spec: {
            type: 'aws-cloudformation-stack',
            lifecycle: tags['shersoft-ltd:backstage:lifecycle'] || 'production',
            owner: tags['shersoft-ltd:backstage:owner'] || 'platform',
            dependencyOf: tags['shersoft-ltd:backstage:project']
              ? tags['shersoft-ltd:backstage:project']
              : [],
          },
        }),
      );

      const parsedTemplate = yaml.parse(template.TemplateBody);

      for await (const resources of paginateListStackResources(
        { client: cloudFormationClient },
        {
          StackName: stackName,
        },
      )) {
        resources.StackResourceSummaries?.forEach(resource => {
          if (resource.ResourceType === 'AWS::Lambda::Function') {
            const resourceDetail =
              parsedTemplate.Resources[resource.LogicalResourceId!];

            const lambdaResourceName =
              'aws-lmb-' +
              crypto
                .createHash('shake256', { outputLength: 27 })
                .update(
                  Buffer.from(
                    stack.Stacks![0]!.StackId! + resource.LogicalResourceId!,
                    'utf-8',
                  ),
                )
                .digest()
                .toString('hex');

            emit(
              processingResult.entity(location, {
                apiVersion: 'backstage.io/v1alpha1',
                kind: 'Resource',
                metadata: {
                  name: lambdaResourceName,
                  description: `Auto-detected AWS Lambda function: ${resource.PhysicalResourceId}`,
                  annotations: {
                    [`${TechMaturityCatalogProcessor.AnnotationPrefix}region`]:
                      region,
                    [`${TechMaturityCatalogProcessor.AnnotationPrefix}lookedUpWith`]:
                      roleArn,
                    [`${TechMaturityCatalogProcessor.AnnotationPrefix}accountId`]:
                      accountId,
                    [`${TechMaturityCatalogProcessor.AnnotationPrefix}functionName`]:
                      resource.PhysicalResourceId!,
                    [`${TechMaturityCatalogProcessor.AnnotationPrefix}cloudFormationStackName`]:
                      stackName,
                    [`${TechMaturityCatalogProcessor.AnnotationPrefix}cloudFormationLogicalId`]:
                      resource.LogicalResourceId!,
                  },
                  links: [
                    {
                      url: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?filteringText=&filteringStatus=active&viewNested=true&stackId=${encodeURIComponent(
                        stack.Stacks![0].StackId!,
                      )}`,
                      title: 'CloudFormation stack in the AWS console',
                    },
                  ],
                },
                spec: {
                  type: 'aws-lambda-function',
                  lifecycle:
                    tags['shersoft-ltd:backstage:lifecycle'] || 'production',
                  owner: tags['shersoft-ltd:backstage:owner'] || 'platform',
                  dependencyOf: [
                    ...(tags['shersoft-ltd:backstage:project']
                      ? tags['shersoft-ltd:backstage:project']
                      : []),
                    `resource:${stackResourceName}`,
                  ],
                  dependsOn: [
                    `resource:aws-lambda-runtime-${resourceDetail.Properties.Runtime}`,
                  ],
                },
              }),
            );
          }
        });
      }
    } catch (err) {
      logger.warn('failed to read CloudFormation stack', { err });
    }

    return true;
  }
}
