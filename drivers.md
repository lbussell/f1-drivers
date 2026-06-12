Design and build a modern, awards-worthy interactive visualization of F1 drivers and how they moved between teams over the years. Here is what I am thinking to start with.

- Use a script to pull data from the https://openf1.org API to build a static dataset that powers the data visualization. Re-running the script to update the dataset whenever we want.
- The end product should be a static site.
- Use modern web technologies (GSAP, D3, and/or Three.js etc.) to build a visually captivating experience.
- Be sure to check your work with playwright CLI. Ensure it's mobile friendly too.

Visualization details:

- The visualization will be a time series graph where each driver gets their own line.
- One year is selected at a time in the center of the screen. You can scroll back and forth between years using the mouse/touchpad or on-screen buttons. Snap to the years when scrolling. Years are laid out left-to-right along the bottom of the screen.
- Each driver each year shows up as a large circle cutout/portrait on the graph for the current year, with their driver photo. The driver portrait has a team color border or highlight.
- The driver portraits/pucks should show their driver number and their three-leter abbreviated name.
- The drivers' time series travel lines are thick lines that have some transparency by default.
- When you hover over a driver, their timeline becomes highlighted. It should also show the number of points they scored that year.
- You can switch the sorting between driver's championship and constructor's championship results order.
- If a driver is switched out in the middle of a season, we'll need a way to show that.
- New or returning drivers and retiring drivers should have their line fall down and fade away.

Driver details:

- Clicking on a driver shows a flyout or popup showing more details, like for each year:
    - What team they were on
    - How many points they scored
    - Number of pole positions/podiums/wins
    - Driver's championship standing
- Additionally: First race, last race, first pole, first win, last pole, last win.

