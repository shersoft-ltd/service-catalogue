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
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { Logger } from 'winston';
import * as yaml from 'yaml';
import * as crypto from 'crypto';

export class TechMaturityCatalogProcessor2 implements CatalogProcessor {
  private static ResourceType = 'cdk-cloudformation-stack';

  private static AnnotationPrefix = 'shersoft.cloud/';

  // private static ValidResourceStatuses: ResourceStatus[] = [
  //   ResourceStatus.CREATE_COMPLETE,
  //   ResourceStatus.IMPORT_COMPLETE,
  //   ResourceStatus.UPDATE_COMPLETE,
  // ];

  constructor(private readonly logger: Logger) {}

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
    if (location.type !== TechMaturityCatalogProcessor2.ResourceType) {
      return false;
    }

    const [roleArn, stackName, region] = location.target.split('@');

    const [, , , , accountId, ..._] = roleArn.split(':');

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
        params: {
          RoleArn: roleArn,
        },
      }),
    });

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

          emit(
            processingResult.entity(location, {
              apiVersion: 'backstage.io/v1alpha1',
              kind: 'Resource',
              metadata: {
                name: 'aws-lambda-runtime-' + resourceDetail.Properties.Runtime,
                description: `Auto-detected AWS Lambda runtime: ${resourceDetail.Properties.Runtime}`,
              },
              spec: {
                type: 'aws-lambda-runtime',
                lifecycle: 'production',
                owner: 'aws',
              },
            }),
          );

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
                  [`${TechMaturityCatalogProcessor2.AnnotationPrefix}region`]:
                    region,
                  [`${TechMaturityCatalogProcessor2.AnnotationPrefix}lookedUpWith`]:
                    roleArn,
                  [`${TechMaturityCatalogProcessor2.AnnotationPrefix}accountId`]:
                    accountId,
                  [`${TechMaturityCatalogProcessor2.AnnotationPrefix}functionName`]:
                    resource.PhysicalResourceId!,
                  [`${TechMaturityCatalogProcessor2.AnnotationPrefix}cloudFormationStackName`]:
                    stackName,
                  [`${TechMaturityCatalogProcessor2.AnnotationPrefix}cloudFormationLogicalId`]:
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
                lifecycle: 'unknown',
                owner: 'aws',
                dependsOn: [
                  `resource:aws-lambda-runtime-${resourceDetail.Properties.Runtime}`,
                ],
              },
            }),
          );
        }
      });
    }

    return true;
  }
}
