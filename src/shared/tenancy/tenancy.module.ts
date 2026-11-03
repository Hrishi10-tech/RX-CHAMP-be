import { Global, Module } from '@nestjs/common';
import { PersonFactsReader } from './person-facts.reader';
import { OrgsInViewService } from './orgs-in-view.service';

/** Scope helpers every module may use (docs/4.0/SPEC.md 4). */
@Global()
@Module({
  providers: [PersonFactsReader, OrgsInViewService],
  exports: [PersonFactsReader, OrgsInViewService],
})
export class TenancyModule {}
