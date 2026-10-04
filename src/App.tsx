import { QuestionPreview } from './QuestionPreview';
import { Instructor } from './Instructor';
import { NotFound } from './NotFound';
import { Home } from './Home';
import { Play } from './Play';
import { route } from './paths';

export function App() {
  const path = route();
  if (path === 'instructor') return <Instructor />;
  if (path !== '' && path !== 'index.html') return <NotFound />;
  const params = new URLSearchParams(window.location.search);
  if (params.get('preview') === 'question') return <QuestionPreview />;
  const join = params.get('j');
  if (join) return <Play code={join} />;
  return <Home />;
}
