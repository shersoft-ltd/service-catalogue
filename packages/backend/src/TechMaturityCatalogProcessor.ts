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
  async postProcessEntity(
    entity: Entity,
    _location: LocationSpec,
    _emit: CatalogProcessorEmit,
    _cache: CatalogProcessorCache,
  ): Promise<Entity> {
    //console.log('post processing', entity);
    if (isComponentEntity(entity)) {
      if (!entity.metadata.labels) {
        entity.metadata.labels = {};
      }

      entity.metadata.labels['shersoft.cloud/lowest-nodejs-version'] = '14';
    }
    return entity;
  }
}
