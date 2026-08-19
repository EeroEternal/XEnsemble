import PageHeader from '../components/PageHeader';
import { CustomImagesContent } from './CustomImages';
import { consoleAdminPageClass } from '../lib/consoleTokens';

export default function ImagesManager() {
  return (
    <div className={consoleAdminPageClass}>
      <PageHeader
        title="Images"
        description="Combine components into a pre-installed sandbox image."
      />
      <CustomImagesContent />
    </div>
  );
}
