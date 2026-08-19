import PageHeader from '../components/PageHeader';
import { CustomImagesContent } from './CustomImages';
import { consoleAdminPageClass } from '../lib/consoleTokens';

export default function ImagesManager() {
  return (
    <div className={consoleAdminPageClass}>
      <PageHeader title="Images" />
      <CustomImagesContent />
    </div>
  );
}
