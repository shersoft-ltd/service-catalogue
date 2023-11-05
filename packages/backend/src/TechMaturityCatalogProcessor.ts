import { CatalogProcessor } from '@backstage/plugin-catalog-node';
import { Entity, isResourceEntity } from '@backstage/catalog-model';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import {
  CatalogProcessorCache,
  CatalogProcessorEmit,
} from '@backstage/plugin-catalog-node';
import {
  CloudFormationClient,
  GetTemplateCommand,
  paginateListStackResources,
  ResourceStatus,
} from '@aws-sdk/client-cloudformation';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { Logger } from 'winston';
import * as yaml from 'yaml';

export class TechMaturityCatalogProcessor implements CatalogProcessor {
  private static ResourceType = 'cdk-cloudformation-stack';

  private static ValidResourceStatuses: ResourceStatus[] = [
    ResourceStatus.CREATE_COMPLETE,
    ResourceStatus.IMPORT_COMPLETE,
    ResourceStatus.UPDATE_COMPLETE,
  ];

  constructor(private readonly logger: Logger) {}

  getProcessorName() {
    return 'TechMaturityCatalogProcessor';
  }

  // readLocation(location: LocationSpec$1, optional: boolean, emit: CatalogProcessorEmit, parser: CatalogProcessorParser, cache: CatalogProcessorCache)

  async postProcessEntity(
    entity: Entity,
    location: LocationSpec,
    emit: CatalogProcessorEmit,
    _cache: CatalogProcessorCache,
  ): Promise<Entity> {
    if (
      isResourceEntity(entity) &&
      entity.spec.type === TechMaturityCatalogProcessor.ResourceType
    ) {
      if (
        typeof entity.metadata['roleArn'] !== 'string' ||
        typeof entity.metadata['stackName'] !== 'string' ||
        typeof entity.metadata['region'] !== 'string'
      ) {
        throw new Error(
          `You must set a 'roleArn', 'stackName' and 'region' in the metadata of resource ${entity.metadata.namespace}/${entity.metadata.name}`,
        );
      }

      const roleArn = entity.metadata['roleArn'];
      const stackName = entity.metadata['stackName'];
      const region = entity.metadata['region'];
      const accountId = roleArn.split(':')[4];

      const cloudFormationClient = new CloudFormationClient({
        credentials: fromTemporaryCredentials({
          params: {
            RoleArn: roleArn,
          },
        }),
      });

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

      if (!entity.spec.dependsOn) {
        entity.spec.dependsOn = [];
      }
      //
      // entity.spec.dependsOn.push(
      //   `aws-cloudformation-template-${accountId}-${region}-${stackName}`,
      // );

      // emit({
      //   type: 'entity',
      //   entity: {
      //     apiVersion: 'backstage.io/v1alpha1',
      //     kind: 'Resource',
      //     metadata: {
      //       name: `aws-cloudformation-template-${accountId}-${region}-${stackName}`,
      //       description: `Auto-detected AWS CloudFormation Stack.`,
      //       'aws-account-id': accountId,
      //       'aws-region': region,
      //       'stack-name': stackName,
      //     },
      //     spec: {
      //       type: 'aws-cloudformation-template',
      //       lifecycle: 'unknown',
      //       owner: 'aws',
      //       dependsOn: [`resource:${entity.metadata.name}`],
      //     },
      //   },
      //   location,
      // });

      // TODO: maybe check stack state?

      for await (const resources of paginateListStackResources(
        { client: cloudFormationClient },
        {
          StackName: stackName,
        },
      )) {
        resources.StackResourceSummaries?.filter(resource => {
          const ctx = {
            resourceStatus: resource.ResourceStatus,
            resourceType: resource.ResourceType,
            logicalResourceId: resource.LogicalResourceId,
          };

          if (
            TechMaturityCatalogProcessor.ValidResourceStatuses.includes(
              resource.ResourceStatus as ResourceStatus,
            )
          ) {
            this.logger.debug('resource is in valid status', ctx);

            return true;
          } else {
            this.logger.debug('resource is not in valid status', ctx);

            return false;
          }
        }).forEach(resource => {
          if (resource.ResourceType === 'AWS::Lambda::Function') {
            const resourceDetail =
              parsedTemplate.Resources[resource.LogicalResourceId!];

            emit({
              type: 'entity',
              entity: {
                apiVersion: 'backstage.io/v1alpha1',
                kind: 'Resource',
                metadata: {
                  name:
                    'aws-lambda-runtime-' + resourceDetail.Properties.Runtime,
                  description: `Auto-detected AWS Lambda runtime: ${resourceDetail.Properties.Runtime}`,
                },
                spec: {
                  type: 'aws-lambda-runtime',
                  lifecycle: 'production',
                  owner: 'aws',
                },
              },
              location,
            });

            const lambdaResourceName = (
              'aws-lmb-' +
              resource
                .PhysicalResourceId!.replaceAll(':', '')
                .replaceAll('/', '-')
            ).substring(0, 63);

            emit({
              type: 'entity',
              entity: {
                apiVersion: 'backstage.io/v1alpha1',
                kind: 'Resource',
                metadata: {
                  name: lambdaResourceName,
                  description: `Auto-detected AWS Lambda function: ${resource.PhysicalResourceId}`,
                },
                spec: {
                  type: 'aws-lambda-function',
                  lifecycle: 'unknown',
                  owner: 'aws',
                  dependsOn: [
                    `resource:aws-lambda-runtime-${resourceDetail.Properties.Runtime}`,
                  ],
                  dependencyOf: [`resource:${entity.metadata.name}`],
                },
              },
              location,
            });

            entity.spec.dependsOn?.push(`resource:${lambdaResourceName}`);
          }
        });
      }
    }

    return entity;
  }
}
