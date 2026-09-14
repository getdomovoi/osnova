using System;

namespace Sample
{
    public class Program
    {
        private const int MaxRuns = 5;

        public string Start()
        {
            return Describe(MaxRuns);
        }

        public string Describe(int runs)
        {
            return $"runs {runs}";
        }
    }
}
