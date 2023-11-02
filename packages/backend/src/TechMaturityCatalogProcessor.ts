import { CatalogProcessor } from '@backstage/plugin-catalog-node';
import { Entity } from '@backstage/catalog-model';
import { LocationSpec as LocationSpec$1 } from '@backstage/plugin-catalog-common';

export class TechMaturityCatalogProcessor implements CatalogProcessor {
  getProcessorName() {
    return 'TechMaturityCatalogProcessor';
  }
  postProcessEntity?(
    entity: Entity,
    location: LocationSpec$1,
    emit: CatalogProcessorEmit,
    cache: CatalogProcessorCache,
  ): Promise<Entity> {
    console.log('post processing', entity);
    return entity;
  }
}
