import { CatalogProcessor } from '@backstage/plugin-catalog-node';
import { Entity, isComponentEntity } from '@backstage/catalog-model';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import {
  CatalogProcessorCache,
  CatalogProcessorEmit,
} from '@backstage/plugin-catalog-node';

export class TechMaturityCatalogProcessor implements CatalogProcessor {
  getProcessorName() {
    return 'TechMaturityCatalogProcessor';
  }

  async preProcessEntity(
    entity: Entity,
    _location: LocationSpec,
    _emit: CatalogProcessorEmit,
    _location2: LocationSpec,
    _cache: CatalogProcessorCache,
  ): Promise<Entity> {
    //console.log('post processing', entity);
    if (isComponentEntity(entity)) {
      if (!entity.metadata.labels) {
        entity.metadata.labels = {};
      }

      const version = '14';

      entity.metadata.labels['shersoft.cloud/lowest-nodejs-version'] = '14';

      if (!entity.spec.dependsOn) {
        entity.spec.dependsOn = [];
      }

      entity.spec.dependsOn.push('resource:default/node' + version);
    }
    return entity;
  }
}
